// native/wasapi-loopback/addon.cc
//
// Per-process audio session metering (IAudioSessionManager2 +
// IAudioMeterInformation). Musik's own PID is always excluded so it can't
// duck itself. A background thread owns COM; the session list is rebuilt
// every SESSION_REFRESH_MS and the cached meters are read every METER_POLL_MS.

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
#include <chrono>

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace {

std::thread g_captureThread;
std::atomic<bool> g_running{false};
std::atomic<double> g_level{0.0};

std::mutex g_configMutex;
std::unordered_set<DWORD> g_excludedPids;   // always includes our own PID
std::unordered_set<DWORD> g_targetPids;     // empty == no target filter

// Fast attack, slow decay. Time constants in ms, independent of poll rate.
constexpr double ATTACK_MS = 33.0;
constexpr double DECAY_MS = 585.0;
constexpr DWORD METER_POLL_MS = 8;
constexpr int SESSION_REFRESH_MS = 100;

void UpdateLevel(double rawLevel, double dtMs) {
  double prev = g_level.load(std::memory_order_relaxed);
  double tau = (rawLevel > prev) ? ATTACK_MS : DECAY_MS;
  double coeff = 1.0 - std::exp(-dtMs / tau);
  g_level.store(prev + (rawLevel - prev) * coeff, std::memory_order_relaxed);
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

// One pass over active sessions. Fills `collect` if non-null (GetSessions);
// returns the max peak among sessions passing the exclude/target filter.
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

// Meter interfaces for every session on the default output device. The
// device/manager/enumerator stay alive until the next rebuild so meters stay valid.
class SessionCache {
 public:
  ~SessionCache() { Clear(); }

  void Clear() {
    for (auto& e : entries_) {
      if (e.meter) e.meter->Release();
    }
    entries_.clear();
    if (sessionEnum_) { sessionEnum_->Release(); sessionEnum_ = nullptr; }
    if (sessionManager_) { sessionManager_->Release(); sessionManager_ = nullptr; }
    if (device_) { device_->Release(); device_ = nullptr; }
  }

  void Rebuild(IMMDeviceEnumerator* enumerator) {
    Clear();
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device_))) { Clear(); return; }
    if (FAILED(device_->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&sessionManager_))) { Clear(); return; }
    if (FAILED(sessionManager_->GetSessionEnumerator(&sessionEnum_))) { Clear(); return; }

    int count = 0;
    if (FAILED(sessionEnum_->GetCount(&count))) { Clear(); return; }

    for (int i = 0; i < count; i++) {
      IAudioSessionControl* control = nullptr;
      if (FAILED(sessionEnum_->GetSession(i, &control)) || !control) continue;

      IAudioSessionControl2* control2 = nullptr;
      if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&control2)) && control2) {
        DWORD pid = 0;
        AudioSessionState state = AudioSessionStateInactive;
        control2->GetProcessId(&pid);
        // Inactive sessions are kept so a sound is caught the instant it starts.
        if (SUCCEEDED(control2->GetState(&state)) && state != AudioSessionStateExpired) {
          IAudioMeterInformation* meter = nullptr;
          if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioMeterInformation), (void**)&meter)) && meter) {
            entries_.push_back({pid, meter});
          }
        }
        control2->Release();
      }
      control->Release();
    }
  }

  // Max peak across cached sessions that pass the exclude/target filter.
  double MaxPeak() {
    double maxPeak = 0.0;
    std::lock_guard<std::mutex> lock(g_configMutex);
    for (auto& e : entries_) {
      if (g_excludedPids.count(e.pid) > 0) continue;
      if (!g_targetPids.empty() && g_targetPids.count(e.pid) == 0) continue;
      float peak = 0.0f;
      if (SUCCEEDED(e.meter->GetPeakValue(&peak)) && (double)peak > maxPeak) maxPeak = (double)peak;
    }
    return maxPeak;
  }

 private:
  struct Entry { DWORD pid; IAudioMeterInformation* meter; };
  std::vector<Entry> entries_;
  IMMDevice* device_ = nullptr;
  IAudioSessionManager2* sessionManager_ = nullptr;
  IAudioSessionEnumerator* sessionEnum_ = nullptr;
};

// High-resolution timer wait (plain Sleep rounds up to ~15ms). Falls back to Sleep.
void WaitMs(HANDLE timer, DWORD ms) {
  if (timer) {
    LARGE_INTEGER due;
    due.QuadPart = -static_cast<LONGLONG>(ms) * 10000LL;
    if (SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) {
      WaitForSingleObject(timer, ms + 20);
      return;
    }
  }
  Sleep(ms);
}

void CaptureThreadMain() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { g_running.store(false); return; }

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                         __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) { CoUninitialize(); g_running.store(false); return; }

  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);

  using clock = std::chrono::steady_clock;
  SessionCache cache;
  auto last = clock::now();
  auto lastRefresh = last - std::chrono::milliseconds(SESSION_REFRESH_MS); // forces a build on the first pass

  while (g_running.load(std::memory_order_relaxed)) {
    auto now = clock::now();
    double dtMs = std::chrono::duration<double, std::milli>(now - last).count();
    last = now;
    if (dtMs > 250.0) dtMs = 250.0; // a stalled thread shouldn't cause one huge jump

    if (now - lastRefresh >= std::chrono::milliseconds(SESSION_REFRESH_MS)) {
      cache.Rebuild(enumerator);
      lastRefresh = now;
    }

    UpdateLevel(cache.MaxPeak(), dtMs);
    WaitMs(timer, METER_POLL_MS);
  }

  cache.Clear(); // must release COM objects before CoUninitialize
  if (timer) CloseHandle(timer);
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

// setTargetProcesses([pid, ...]) — non-empty: only those PIDs count.
// Empty: everything except excluded.
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

// setExcludedProcesses([pid, ...]) — live update. Musik's own PID is always re-added.
Napi::Value SetExcludedProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(g_configMutex);
  g_excludedPids.clear();
  g_excludedPids.insert(GetCurrentProcessId());
  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array arr = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr[i];
      if (v.IsNumber()) g_excludedPids.insert((DWORD)v.As<Napi::Number>().Uint32Value());
    }
  }
  return Napi::Boolean::New(env, true);
}

// Synchronous one-shot list of active sessions for the UI. Does its own
// CoInitialize since it runs on the caller's thread.
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
  exports.Set("setExcludedProcesses", Napi::Function::New(env, SetExcludedProcesses));
  exports.Set("getSessions", Napi::Function::New(env, GetSessions));
  return exports;
}

} // namespace

NODE_API_MODULE(wasapi_loopback, Init)
