// src/core/game-duck.js
//
// Main-process controller for reactive volume ducking. Wraps the
// native/wasapi-loopback addon (Windows-only, per-process session
// metering — see addon.cc) and turns its live level into a smoothed
// 0..1 multiplier pushed to the renderer as 'duckupdate'.
//
// v2 fix (this pass): addon.cc already excludes Musik's own PID via
// per-session metering, so the old "ducking itself" theory was wrong.
// Real bug was the multiplier ramp assuming level travels all the way
// to 1.0 (true digital-scale clipping) before reaching maxDuck. Real
// game audio peaks rarely get anywhere near that, so the old curve
// barely ducked at all. Fixed via a new `duckCeiling` setting — the
// level treated as "fully loud" — default well below 1.0.
//
// Also added: optional debug callback in init() so callers can wire up
// a live level/multiplier readout (Settings meter, on-screen toast on
// Ctrl+Shift+D, whatever). Purely additive — existing 2-arg init() call
// sites keep working unchanged.
//
// Settings semantics:
//   enabled        — master on/off (Settings toggle)
//   sensitivity     0..1 — level threshold above which ducking starts
//                    kicking in. Lower = ducks on quieter sounds.
//   duckCeiling     0..1 — level treated as "fully loud" for ramp
//                    purposes. NEW. Must be > sensitivity. Real game
//                    peaks rarely approach 1.0, so this used to make
//                    the duck effectively never reach maxDuck. Default
//                    0.4 — tune per-game if needed later via a UI slider.
//   maxDuck         0..1 — floor multiplier when fully ducked (e.g. 0.3
//                    means volume never drops below 30% no matter how
//                    loud the target app gets)
//   manualOverride  — Ctrl+Shift+D in player-ui.js. When true, ducking is
//                    forced off (multiplier always 1.0) regardless of
//                    `enabled` or live level. Not persisted — resets to
//                    false on relaunch, matching the renderer-side comment.
//
// Multiplier curve: below `sensitivity`, multiplier is 1.0 (no duck).
// From `sensitivity` to `duckCeiling` level, multiplier ramps linearly
// down to `maxDuck`. At or above `duckCeiling`, multiplier is pinned to
// `maxDuck`. Smoothed with simple attack/decay so it doesn't snap.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: false,
  sensitivity: 0.15,
  duckCeiling: 0.4,
  maxDuck: 0.35,
};

// Separate from persisted settings — resets every launch by design.
let manualOverride = false;

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
// feel like it's chattering when a game's audio is bursty.
const DUCK_IN = 0.35;
const DUCK_RELEASE = 0.08;
const POLL_MS = 100;

function loadAddon() {
  if (process.platform !== 'win32') return null;
  try {
    // Adjust path if the native module ends up living elsewhere — kept
    // relative to project root via __dirname since this file is in
    // src/core/.
    return require(path.join(__dirname, '..', '..', 'native', 'wasapi-loopback'));
  } catch (err) {
    console.warn('[Musik] game-duck: native addon not available:', err.message);
    return null;
  }
}

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

function computeTargetMultiplier(level) {
  if (manualOverride) return 1.0;
  if (!settings.enabled) return 1.0;
  if (level <= settings.sensitivity) return 1.0;

  const ceiling = Math.max(settings.duckCeiling, settings.sensitivity + 0.001);
  const range = ceiling - settings.sensitivity;
  const over = range > 0 ? (level - settings.sensitivity) / range : 1.0;
  const clamped = Math.max(0, Math.min(1, over));
  // over=0 -> multiplier 1.0 (just crossed threshold), over=1 -> maxDuck
  return 1.0 - clamped * (1.0 - settings.maxDuck);
}

function tick() {
  if (!addon) return;
  const level = addon.getLevel();
  const target = computeTargetMultiplier(level);
  const coeff = target < smoothedMultiplier ? DUCK_IN : DUCK_RELEASE;
  smoothedMultiplier += (target - smoothedMultiplier) * coeff;
  onMultiplierChange(smoothedMultiplier);
  if (onDebugTick) onDebugTick(level, target, smoothedMultiplier);
}

function startPolling() {
  if (pollInterval || !addon) return;
  try {
    addon.start();
  } catch (err) {
    console.warn('[Musik] game-duck: addon.start() failed:', err.message);
    return;
  }
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
  onMultiplierChange(1.0);
}

function syncPollingState() {
  // Poll whenever the feature is enabled — manualOverride still forces
  // the multiplier to 1.0 inside computeTargetMultiplier(), but we keep
  // the addon running so there's no start/stop lag when override toggles
  // back off mid-session.
  if (settings.enabled && available) {
    startPolling();
  } else {
    stopPolling();
  }
}

// userDataPath, onMultiplierChangeCb: (multiplier:number) => void  [existing contract, unchanged]
// onDebugTickCb (optional, NEW): (level:number, target:number, smoothed:number) => void
//   Fire this into an IPC event (e.g. 'duckdebug') if you want a live
//   meter in Settings or an on-screen readout. Omit entirely and nothing
//   about existing call sites needs to change.
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
    manualOverride,
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
  // Not persisted — intentional, see file header.
  return getSettings();
}

// Optional, for a future Settings UI process picker — mirrors the
// addon's getSessions() so callers don't need to reach into
// native/wasapi-loopback directly.
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

module.exports = {
  init,
  getSettings,
  setEnabled,
  setSensitivity,
  setDuckCeiling,
  setMaxDuck,
  setManualOverride,
  getAudioSessions,
  setTargetProcesses,
};
