// native/wasapi-loopback/addon.cc
//
// v2 — per-process session metering (replaces raw system loopback).
//
// WHY THIS CHANGED FROM v1:
// v1 used AUDCLNT_STREAMFLAGS_LOOPBACK on the default render device,
// which captures the entire system mix — every app's audio summed
// together, including Musik's own output. That caused a feedback
// problem: when Musik played louder, the meter read "system is loud"
// and ducked Musik itself, which is never what anyone wants and reads
// as "the song got quieter but the game didn't get louder."
//
// v2 uses IAudioSessionManager2 to enumerate individual per-process
// audio sessions and reads each session's own peak meter via
// IAudioMeterInformation::GetPeakValue(). This is the API Windows
// exposes specifically so you don't have to demix raw PCM yourself.
// Musik's own process is always excluded by PID. Callers can also pass
// an explicit allow-list of PIDs (e.g. "only duck for Forza") — if
// omitted, the max peak across all other active sessions is used.
//
// Threading model: unchanged in spirit from v1. Start() spins a
// dedicated background thread that owns COM for its lifetime and
// re-enumerates sessions on every poll tick (session lists change as
// apps open/close audio streams — re-enumerating is cheap compared to
// raw buffer capture, so this is fine at ~30ms intervals). The smoothed
// level is shared via std::atomic<double>; excluded/target PID sets are
// guarded by a small mutex since they change rarely (once per call from
// JS) but are read every tick.

#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <psapi.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <vector>
#include <unordered_set>
#include <string>
#include <cmath>

namespace {

std::thread g_captureThread;
std::atomic<bool> g_running{false};
std::atomic<double> g_level{0.0};

std::mutex g_configMutex;
std::unordered_set<DWORD> g_excludedPids;   // always includes our own PID
std::unordered_set<DWORD> g_targetPids;     // empty == "consider everything not excluded"

// Same ballistics as v1 — fast attack, slow decay, so the level reads
// as musical rather than jittering every ~30ms poll.
constexpr double ATTACK = 0.6;
constexpr double DECAY = 0.05;

void UpdateLevel(double rawLevel) {
  double prev = g_level.load(std::memory_order_relaxed);
  double coeff = (rawLevel > prev) ? ATTACK : DECAY;
  double next = prev + (rawLevel - prev) * coeff;
  g_level.store(next, std::memory_order_relaxed);
}

std::string GetProcessName(DWORD pid) {
  if (pid == 0) return "System Sounds";
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return "";
  wchar_t nameBuf[MAX_PATH] = {0};
  DWORD size = MAX_PATH;
  std::string result;
  if (QueryFullProcessImageNameW(h, 0, nameBuf, &size)) {
    std::wstring wpath(nameBuf);
    size_t slash = wpath.find_last_of(L"\\/");
    std::wstring wname = (slash == std::wstring::npos) ? wpath : wpath.substr(slash + 1);
    int len = WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (len > 0) {
      result.resize(len - 1);
      WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, &result[0], len, nullptr, nullptr);
    }
  }
  CloseHandle(h);
  return result;
}

// One pass over current sessions. If `collect` is non-null, fills it with
// every active session found (used by the synchronous GetSessions() call).
// Returns the max peak among sessions that pass the exclude/target filter
// (used by the background polling loop).
double PollSessionsOnce(IMMDeviceEnumerator* enumerator,
                         std::vector<std::pair<DWORD, std::pair<std::string, double>>>* collect) {
  IMMDevice* device = nullptr;
  IAudioSessionManager2* sessionManager = nullptr;
  IAudioSessionEnumerator* sessionEnum = nullptr;
  double maxPeak = 0.0;

  auto cleanup = [&]() {
    if (sessionEnum) sessionEnum->Release();
    if (sessionManager) sessionManager->Release();
    if (device) device->Release();
  };

  if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) { cleanup(); return 0.0; }
  if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&sessionManager))) { cleanup(); return 0.0; }
  if (FAILED(sessionManager->GetSessionEnumerator(&sessionEnum))) { cleanup(); return 0.0; }

  int count = 0;
  if (FAILED(sessionEnum->GetCount(&count))) { cleanup(); return 0.0; }

  std::unordered_set<DWORD> excluded, target;
  {
    std::lock_guard<std::mutex> lock(g_configMutex);
    excluded = g_excludedPids;
    target = g_targetPids;
  }

  for (int i = 0; i < count; i++) {
    IAudioSessionControl* control = nullptr;
    if (FAILED(sessionEnum->GetSession(i, &control)) || !control) continue;

    IAudioSessionControl2* control2 = nullptr;
    if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&control2)) && control2) {
      AudioSessionState state;
      DWORD pid = 0;
      control2->GetProcessId(&pid);
      if (SUCCEEDED(control2->GetState(&state)) && state == AudioSessionStateActive) {
        IAudioMeterInformation* meter = nullptr;
        if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioMeterInformation), (void**)&meter)) && meter) {
          float peak = 0.0f;
          meter->GetPeakValue(&peak);
          meter->Release();

          if (collect) {
            collect->push_back({pid, {GetProcessName(pid), (double)peak}});
          }

          bool isExcluded = excluded.count(pid) > 0;
          bool passesTarget = target.empty() || target.count(pid) > 0;
          if (!isExcluded && passesTarget) {
            if ((double)peak > maxPeak) maxPeak = (double)peak;
          }
        }
      }
      control2->Release();
    }
    control->Release();
  }

  cleanup();
  return maxPeak;
}

void CaptureThreadMain() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { g_running.store(false); return; }

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                         __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) { CoUninitialize(); g_running.store(false); return; }

  while (g_running.load(std::memory_order_relaxed)) {
    double peak = PollSessionsOnce(enumerator, nullptr);
    UpdateLevel(peak);
    Sleep(30); // ~33Hz — session enumeration is cheap, no need to poll faster
  }

  if (enumerator) enumerator->Release();
  CoUninitialize();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  {
    std::lock_guard<std::mutex> lock(g_configMutex);
    g_excludedPids.clear();
    g_excludedPids.insert(GetCurrentProcessId()); // always exclude Musik itself
    if (info.Length() > 0 && info[0].IsArray()) {
      Napi::Array arr = info[0].As<Napi::Array>();
      for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value v = arr[i];
        if (v.IsNumber()) g_excludedPids.insert((DWORD)v.As<Napi::Number>().Uint32Value());
      }
    }
  }

  if (g_running.load()) return Napi::Boolean::New(env, true); // already running
  g_running.store(true);
  g_captureThread = std::thread(CaptureThreadMain);
  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  g_running.store(false);
  if (g_captureThread.joinable()) g_captureThread.join();
  g_level.store(0.0);
  return Napi::Boolean::New(env, true);
}

Napi::Value GetLevel(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), g_level.load(std::memory_order_relaxed));
}

// setTargetProcesses([pid, pid, ...]) — if called with a non-empty array,
// getLevel() only considers those PIDs. Call with an empty array (or
// don't call it at all) to go back to "everything except excluded."
Napi::Value SetTargetProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(g_configMutex);
  g_targetPids.clear();
  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array arr = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr[i];
      if (v.IsNumber()) g_targetPids.insert((DWORD)v.As<Napi::Number>().Uint32Value());
    }
  }
  return Napi::Boolean::New(env, true);
}

// Synchronous one-shot enumeration for UI purposes — "here's everything
// currently making sound, pick which one(s) to duck against." Does its
// own CoInitialize since this runs on whatever thread calls it (expected:
// Node main thread), independent of the background polling thread.
Napi::Value GetSessions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool weInitialized = SUCCEEDED(hr);
  if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return result;

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                         __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) {
    if (weInitialized) CoUninitialize();
    return result;
  }

  std::vector<std::pair<DWORD, std::pair<std::string, double>>> sessions;
  PollSessionsOnce(enumerator, &sessions);
  enumerator->Release();
  if (weInitialized) CoUninitialize();

  DWORD selfPid = GetCurrentProcessId();
  uint32_t idx = 0;
  for (auto& s : sessions) {
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("pid", Napi::Number::New(env, s.first));
    obj.Set("name", Napi::String::New(env, s.second.first));
    obj.Set("peak", Napi::Number::New(env, s.second.second));
    obj.Set("isSelf", Napi::Boolean::New(env, s.first == selfPid));
    result.Set(idx++, obj);
  }
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("getLevel", Napi::Function::New(env, GetLevel));
  exports.Set("setTargetProcesses", Napi::Function::New(env, SetTargetProcesses));
  exports.Set("getSessions", Napi::Function::New(env, GetSessions));
  return exports;
}

} // namespace

NODE_API_MODULE(wasapi_loopback, Init)
