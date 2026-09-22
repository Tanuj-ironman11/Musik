// src/core/game-duck.js
//
// Main-process controller for reactive volume ducking. Wraps the
// native/wasapi-loopback addon (Windows-only, per-process session
// metering — see addon.cc) and turns its live level into a smoothed
// 0..1 multiplier pushed to the renderer as 'duckupdate'.
//
// Settings semantics:
//   enabled        — master on/off (Settings toggle)
//   sensitivity     0..1 — level threshold above which ducking starts
//                    kicking in. Lower = ducks on quieter sounds.
//   duckCeiling     0..1 — level treated as "fully loud" for ramp
//                    purposes. Must be > sensitivity. Default 0.4.
//   maxDuck         0..1 — floor multiplier when fully ducked (e.g. 0.3
//                    means volume never drops below 30% no matter how
//                    loud the target app gets)
//   manualOverride  — Ctrl+Shift+D in player-ui.js. When true, ducking is
//                    forced off (multiplier always 1.0) regardless of
//                    `enabled` or live level. Not persisted — resets to
//                    false on relaunch.
//
// Multiplier curve: below effective sensitivity, multiplier is 1.0 (no
// duck). From effective sensitivity to effective duckCeiling, multiplier
// ramps linearly down to maxDuck. At/above ceiling, pinned to maxDuck.
// Smoothed with time-based attack/release plus a release hold (see the
// ballistics constants) so it doesn't snap or pump on bursty audio.
//
// Track-loudness auto-tuning (setTrackLoudness): player-ui.js feeds a
// rolling BS.1770-ish LUFS estimate of the currently playing track. A
// quiet track (e.g. -28 LUFS) needs the game to be relatively less loud
// before ducking makes sense to the ear, so effective sensitivity/ceiling
// shift down; a loud track (e.g. -8 LUFS) shifts them up. Reference point
// is -18 LUFS (roughly "normal" streaming-normalized loudness) — no
// adjustment at that point. Adjustment is clamped so it can only nudge
// the curve, never invert sensitivity > ceiling or push either out of
// 0..1.
//
// Self-exclusion (added — fixes feedback loop): the addon only auto-
// excludes the PID of whatever process calls addon.start(). Electron
// apps are multiple OS processes (main/browser, renderer(s), GPU,
// utility) — Musik's actual audio comes out of a renderer process, not
// the main process that calls start(). Previously only the main
// process PID was excluded, so the addon saw Musik's own renderer
// audio as "an outside app," ducked it, saw the level drop, un-ducked,
// saw it rise again, and looped — audibly "tweaking" the volume.
// getOwnProcessPids() pulls every PID belonging to this Electron
// instance via app.getAppMetrics() and hands the whole list to
// addon.start(), which unions it with its own GetCurrentProcessId()
// call on the native side. addon.cc re-applies whatever exclude list
// is passed EVERY time start() is called, even if already running, so
// this can be safely re-called later (e.g. after a new window like the
// miniplayer spawns a new renderer PID) without needing to stop/start
// the capture thread. That refresh-on-new-window wiring isn't added
// yet — flagging it as a known follow-up, not doing it here to keep
// this patch surgical.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  enabled: false,
  sensitivity: 0.15,
  duckCeiling: 0.4,
  maxDuck: 0.35,
  // Process names (not PIDs — PIDs change every relaunch) that should
  // never count toward ducking, e.g. a notch-widget visualizer that has
  // its own active audio session but isn't something to duck for.
  excludedProcessNames: [],
};

const LUFS_REFERENCE = -18;
const LUFS_ADJUST_RANGE = 20; // +/-20 LUFS from reference maps to +/-MAX_LUFS_ADJUST
const MAX_LUFS_ADJUST = 0.12; // cap on how far loudness can shift sensitivity/ceiling

// Separate from persisted settings — resets every launch by design.
let manualOverride = false;
let trackLoudnessLufs = null; // null = no adjustment (silence/no track/not yet measured)

let settings = { ...DEFAULTS };
let settingsPath = null;

let addon = null;
let available = false;
let pollInterval = null;
let smoothedMultiplier = 1.0;
let onMultiplierChange = () => {};
let onDebugTick = null; // optional: (level, target, smoothed) => void

// Ballistics for the OUTPUT multiplier (separate from the addon's own
// internal level smoothing) — duck-in fast, release slow, so it doesn't
// feel like it's chattering when a game's audio is bursty or when someone
// is talking (speech = short bursts with tiny gaps between words).
//
// Time-based, NOT per-tick: the old per-tick coefficients (0.35 / 0.08 at
// 100ms) meant changing POLL_MS silently changed how the ducking felt.
// Now the time constants are in ms and the per-tick coefficient is derived
// from the real elapsed time (1 - e^(-dt/tau)).
//
// These five numbers are TUNING values (subjective feel), not bug fixes.
const POLL_MS = 30;           // how often the level is sampled
const DUCK_IN_MS = 50;        // attack time constant — how fast it ducks
const DUCK_RELEASE_MS = 900;  // release time constant — how slowly it recovers
const HOLD_MS = 700;          // after the last "still ducking" moment, wait this long before releasing (bridges gaps between words/sentences)
const SNAP_EPSILON = 0.002;   // within this of target = land exactly on it (stops endless tiny updates)

function loadAddon() {
  if (process.platform !== 'win32') return null;
  try {
    return require(path.join(__dirname, '..', '..', 'native', 'wasapi-loopback'));
  } catch (err) {
    console.warn('[Musik] game-duck: native addon not available:', err.message);
    return null;
  }
}

// Every OS process belonging to this Electron instance — browser (main),
// all renderers, GPU, utility, etc. Musik's actual audio output lives in
// one of the renderer processes, not necessarily the main process, so
// excluding only process.pid (or letting the addon default to whoever
// called start()) isn't enough. See file-header note.
let lastLoggedPidsKey = null; // only re-log when the set actually changes, avoid spam
function getOwnProcessPids() {
  try {
    const pids = app.getAppMetrics().map((m) => m.pid);
    const key = pids.slice().sort((a, b) => a - b).join(',');
    if (key !== lastLoggedPidsKey) {
      lastLoggedPidsKey = key;
      console.log('[Musik] game-duck: excluding own PIDs:', pids);
    }
    return pids;
  } catch (err) {
    console.warn('[Musik] game-duck: getAppMetrics() failed, falling back to own PID only:', err.message);
    return [process.pid];
  }
}

// Resolves settings.excludedProcessNames against whatever audio sessions
// are currently active, unions the result with our own PIDs, and pushes
// the combined set to the addon via setExcludedProcesses(). Doesn't touch
// the capture thread's start/stop state — addon.cc's setExcludedProcesses
// updates the live exclude set in place, no restart needed.
function refreshExcludedPids() {
  if (!addon || typeof addon.setExcludedProcesses !== 'function') return;

  const ownPids = getOwnProcessPids();
  const names = (settings.excludedProcessNames || []).map((n) => n.toLowerCase());
  let matchedPids = [];
  if (names.length > 0) {
    try {
      const sessions = addon.getSessions();
      matchedPids = sessions
        .filter((s) => names.includes(String(s.name || '').toLowerCase()))
        .map((s) => s.pid);
    } catch (err) {
      console.warn('[Musik] game-duck: getSessions() failed during exclude refresh:', err.message);
    }
  }

  const combined = Array.from(new Set([...ownPids, ...matchedPids]));
  try {
    addon.setExcludedProcesses(combined);
  } catch (err) {
    console.warn('[Musik] game-duck: setExcludedProcesses() failed:', err.message);
  }
}

// The exclude list is only accurate at the instant it's captured — Musik
// spawns processes lazily (e.g. Chromium's audio-handling process doesn't
// exist until playback actually starts, a new miniplayer window spawns its
// own renderer PID, etc). A one-time snapshot at boot misses all of that.
// addon.cc re-applies whatever PID list is passed EVERY call to start(),
// even while already running, without resetting the capture thread or its
// level smoothing — so it's safe to call this on a timer.
// Time-based (was tick-counted: 20 ticks @ 100ms). Tick-counting would have
// turned into a refresh every 600ms after the POLL_MS change.
let lastRefreshAt = 0;
const REFRESH_EVERY_MS = 2000;

function loadSettingsFromDisk() {
  if (!settingsPath || !fs.existsSync(settingsPath)) return;
  try {
    const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings = { ...DEFAULTS, ...disk };
  } catch (err) {
    console.warn('[Musik] game-duck: failed to read settings, using defaults:', err.message);
  }
}

function saveSettingsToDisk() {
  if (!settingsPath) return;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.warn('[Musik] game-duck: failed to save settings:', err.message);
  }
}

function loudnessAdjustment() {
  if (trackLoudnessLufs === null || !Number.isFinite(trackLoudnessLufs)) return 0;
  const delta = trackLoudnessLufs - LUFS_REFERENCE;
  const normalized = Math.max(-1, Math.min(1, delta / LUFS_ADJUST_RANGE));
  return normalized * MAX_LUFS_ADJUST;
}

function computeTargetMultiplier(level) {
  if (manualOverride) return 1.0;
  if (!settings.enabled) return 1.0;

  const adjust = loudnessAdjustment();
  const effectiveSensitivity = Math.max(0, Math.min(0.95, settings.sensitivity + adjust));
  const effectiveCeiling = Math.max(effectiveSensitivity + 0.001, Math.min(1, settings.duckCeiling + adjust));

  if (level <= effectiveSensitivity) return 1.0;

  const range = effectiveCeiling - effectiveSensitivity;
  const over = range > 0 ? (level - effectiveSensitivity) / range : 1.0;
  const clamped = Math.max(0, Math.min(1, over));
  return 1.0 - clamped * (1.0 - settings.maxDuck);
}

let lastTickAt = 0;
let holdUntil = 0;
let lastSentMultiplier = 1.0;

function tick() {
  if (!addon) return;

  const now = Date.now();
  // Real elapsed time, capped so a stalled main process (long GC, sleep
  // wake) doesn't produce one giant jump.
  const dt = lastTickAt ? Math.min(now - lastTickAt, 250) : POLL_MS;
  lastTickAt = now;

  if (now - lastRefreshAt >= REFRESH_EVERY_MS) {
    lastRefreshAt = now;
    refreshExcludedPids();
  }

  const level = addon.getLevel();
  let target = computeTargetMultiplier(level);

  // Hold: every time the signal is at least as loud as what we're already
  // ducked to, restart the hold timer. While it's running, refuse to
  // release — this is what stops the volume pumping back up in the gaps
  // between words. Only applies while ducking is actually active, so the
  // manual-override hotkey / disabling the feature still releases at once.
  if (target < 1.0 && target <= smoothedMultiplier) {
    holdUntil = now + HOLD_MS;
  } else if (target > smoothedMultiplier && settings.enabled && !manualOverride && now < holdUntil) {
    target = smoothedMultiplier;
  }

  const tau = target < smoothedMultiplier ? DUCK_IN_MS : DUCK_RELEASE_MS;
  smoothedMultiplier += (target - smoothedMultiplier) * (1 - Math.exp(-dt / tau));
  if (Math.abs(target - smoothedMultiplier) < SNAP_EPSILON) smoothedMultiplier = target;

  // Only push when the value actually changed — at 30ms polling that's
  // ~33 msgs/s while moving, zero once it settles.
  if (smoothedMultiplier !== lastSentMultiplier) {
    lastSentMultiplier = smoothedMultiplier;
    onMultiplierChange(smoothedMultiplier);
  }
  if (onDebugTick) onDebugTick(level, target, smoothedMultiplier);
}

function startPolling() {
  if (pollInterval || !addon) return;
  try {
    addon.start(getOwnProcessPids());
  } catch (err) {
    console.warn('[Musik] game-duck: addon.start() failed:', err.message);
    return;
  }
  refreshExcludedPids(); // apply user-excluded names immediately, don't wait for the first periodic refresh
  lastRefreshAt = Date.now();
  lastTickAt = 0;
  holdUntil = 0;
  pollInterval = setInterval(tick, POLL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (addon) {
    try { addon.stop(); } catch (_) {}
  }
  smoothedMultiplier = 1.0;
  lastSentMultiplier = 1.0;
  holdUntil = 0;
  onMultiplierChange(1.0);
}

function syncPollingState() {
  if (settings.enabled && available) {
    startPolling();
  } else {
    stopPolling();
  }
}

// userDataPath, onMultiplierChangeCb: (multiplier:number) => void
// onDebugTickCb (optional): (level:number, target:number, smoothed:number) => void
function init(userDataPath, onMultiplierChangeCb, onDebugTickCb) {
  onMultiplierChange = typeof onMultiplierChangeCb === 'function' ? onMultiplierChangeCb : () => {};
  onDebugTick = typeof onDebugTickCb === 'function' ? onDebugTickCb : null;
  settingsPath = path.join(userDataPath, 'game-duck.json');
  loadSettingsFromDisk();

  addon = loadAddon();
  available = !!addon;

  syncPollingState();
}

function getSettings() {
  return {
    available,
    enabled: settings.enabled,
    sensitivity: settings.sensitivity,
    duckCeiling: settings.duckCeiling,
    maxDuck: settings.maxDuck,
    excludedProcessNames: settings.excludedProcessNames,
    manualOverride,
    trackLoudnessLufs,
  };
}

function setEnabled(value) {
  settings.enabled = !!value;
  saveSettingsToDisk();
  syncPollingState();
  return getSettings();
}

function setSensitivity(value) {
  settings.sensitivity = Math.max(0, Math.min(1, Number(value)));
  saveSettingsToDisk();
  return getSettings();
}

function setDuckCeiling(value) {
  settings.duckCeiling = Math.max(0, Math.min(1, Number(value)));
  saveSettingsToDisk();
  return getSettings();
}

function setMaxDuck(value) {
  settings.maxDuck = Math.max(0, Math.min(1, Number(value)));
  saveSettingsToDisk();
  return getSettings();
}

function setManualOverride(value) {
  manualOverride = !!value;
  return getSettings();
}

// Fed continuously by player-ui.js's rolling LUFS estimate. Pass null to
// clear (new track loading, playback stopped) — see loudnessAdjustment().
function setTrackLoudness(lufs) {
  trackLoudnessLufs = (typeof lufs === 'number' && Number.isFinite(lufs)) ? lufs : null;
}

function getAudioSessions() {
  if (!addon) return [];
  try {
    return addon.getSessions();
  } catch (err) {
    console.warn('[Musik] game-duck: getSessions() failed:', err.message);
    return [];
  }
}

function setTargetProcesses(pids) {
  if (!addon) return false;
  try {
    addon.setTargetProcesses(Array.isArray(pids) ? pids : []);
    return true;
  } catch (err) {
    console.warn('[Musik] game-duck: setTargetProcesses() failed:', err.message);
    return false;
  }
}

// Process names (e.g. "v-notch.exe") to always exclude from ducking
// consideration, no matter how loud their audio session gets. Persisted,
// unlike setTargetProcesses' PID list, since names survive relaunches
// and PIDs don't.
function setExcludedProcessNames(names) {
  settings.excludedProcessNames = Array.isArray(names)
    ? names.filter((n) => typeof n === 'string')
    : [];
  saveSettingsToDisk();
  refreshExcludedPids();
  return getSettings();
}

module.exports = {
  init,
  getSettings,
  setEnabled,
  setSensitivity,
  setDuckCeiling,
  setMaxDuck,
  setManualOverride,
  setTrackLoudness,
  getAudioSessions,
  setTargetProcesses,
  setExcludedProcessNames,
};
