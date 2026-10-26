// src/core/game-duck.js
//
// Main-process controller for reactive volume ducking. Wraps the
// native/wasapi-loopback addon (Windows-only, per-process session
// metering — see addon.cc) and turns its live level into a smoothed
// 0..1 multiplier pushed to the renderer as 'duckupdate'.
//
// Settings semantics:
//   enabled        — master on/off (Settings toggle)
//   sensitivity     0..1 — how readily ducking starts. Higher = ducks on
//                    quieter system audio. Internally the trigger level is
//                    1 - sensitivity.
//   duckCeiling     0..1 — level treated as "fully loud" for ramp
//                    purposes. Must be above the trigger level. Default 0.4.
//   maxDuck         0..1 — AMOUNT removed when fully ducked (e.g. 0.7
//                    means volume drops by 70%, to 30% of normal, at
//                    peak system audio; 1.0 = ducks to silence, 0 = no
//                    ducking). Was a floor multiplier before the
//                    maxDuckIsAmount migration — see loadSettingsFromDisk.
//   manualOverride  — Ctrl+Shift+D in player-ui.js. When true, ducking is
//                    forced off (multiplier always 1.0) regardless of
//                    `enabled` or live level. Not persisted — resets to
//                    false on relaunch.
//
// Presets (preset): gaming, meetings, movies, custom. Every preset except
// custom uses adaptive detection: the trigger level and ceiling follow how
// loud the other audio has been over the last few seconds, so nothing needs
// tuning per game or per call. Each preset also sets its own max duck and
// attack/hold/release timing. Custom uses the manual sliders (sensitivity,
// duckCeiling, maxDuck) and the fixed timings below. Touching any slider
// switches the preset to custom.
//
// Multiplier curve: below the effective trigger level, multiplier is 1.0
// (no duck). From the effective trigger level to effective duckCeiling, multiplier
// ramps linearly down to (1 - maxDuck). At/above ceiling, pinned there.
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
// the curve, never put the trigger level above the ceiling or push either
// out of 0..1.
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
  sensitivity: 0.85,
  duckCeiling: 0.4,
  maxDuck: 0.65,
  maxDuckIsAmount: true, // migration marker: absent on old files where maxDuck was a floor
  sensitivityHigherIsMore: true, // migration marker: absent on old files where sensitivity was the trigger level itself
  // Process names (not PIDs — PIDs change every relaunch) that should
  // never count toward ducking, e.g. a notch-widget visualizer that has
  // its own active audio session but isn't something to duck for.
  excludedProcessNames: [],
  preset: 'gaming',
};

const LUFS_REFERENCE = -18;
const LUFS_ADJUST_RANGE = 20; // +/-20 LUFS from reference maps to +/-MAX_LUFS_ADJUST
const MAX_LUFS_ADJUST = 0.12; // cap on how far loudness can shift sensitivity/ceiling

// Each preset: max duck is the amount removed at full duck; the timings are
// time constants in ms. Movies has no hold, so it follows the audio up and down.
const PRESETS = {
  gaming:   { maxDuck: 0.65, attackMs: 50,  holdMs: 700,  releaseMs: 900 },
  meetings: { maxDuck: 0.85, attackMs: 25,  holdMs: 1400, releaseMs: 700 },
  movies:   { maxDuck: 0.5,  attackMs: 120, holdMs: 0,    releaseMs: 500 },
};
const PRESET_NAMES = [...Object.keys(PRESETS), 'custom'];

// Adaptive detection tuning values. loudRef is the recent loud level of the
// other audio. Ducking starts at ADAPT_TRIGGER_FRAC of it and is full at
// ADAPT_CEILING_FRAC of it.
const REF_MIN = 0.12;            // loudRef never drops below this, so a quiet blip can't count as full loud
const REF_DECAY_MS = 12000;      // how long loudRef takes to forget a loud moment
const ADAPT_TRIGGER_MIN = 0.01;  // anything quieter than this is ignored (idle hiss)
const ADAPT_TRIGGER_FRAC = 0.12;
const ADAPT_CEILING_FRAC = 0.8;
const ADAPT_MIN_SPAN = 0.03;     // trigger to ceiling gap never gets smaller than this

// Separate from persisted settings — resets every launch by design.
let manualOverride = false;
let trackLoudnessLufs = null; // null = no adjustment (silence/no track/not yet measured)

let settings = { ...DEFAULTS };
let settingsPath = null;

let addon = null;
let available = false;
let pollInterval = null;
let smoothedMultiplier = 1.0;
let loudRef = REF_MIN;
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
const POLL_MS = 10;           // how often the level is sampled
const SEND_MIN_MS = 16;       // never push the multiplier to the renderer faster than this
const DEBUG_EVERY_MS = 100;   // debug meter / log rate, independent of the sample rate
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
    let migrated = false;
    // One-time migration: old files stored maxDuck as a floor multiplier
    // (0.35 = duck TO 35%). It's now the amount removed, so flip it.
    if (!disk.maxDuckIsAmount && typeof disk.maxDuck === 'number') {
      settings.maxDuck = Math.max(0, Math.min(1, 1 - disk.maxDuck));
      settings.maxDuckIsAmount = true;
      migrated = true;
    }
    // One-time migration: old files stored sensitivity as the trigger level
    // (higher = needs louder audio), which is the reverse of what the slider
    // says. Flip it so existing users keep the exact same ducking behavior.
    if (!disk.sensitivityHigherIsMore && typeof disk.sensitivity === 'number') {
      settings.sensitivity = Math.max(0, Math.min(1, 1 - disk.sensitivity));
      settings.sensitivityHigherIsMore = true;
      migrated = true;
    }
    if (!PRESET_NAMES.includes(settings.preset)) {
      settings.preset = DEFAULTS.preset;
      migrated = true;
    }
    if (migrated) saveSettingsToDisk();
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

function activeTuning() {
  const preset = PRESETS[settings.preset];
  if (preset) return { ...preset, adaptive: true };
  return {
    maxDuck: settings.maxDuck,
    attackMs: DUCK_IN_MS,
    holdMs: HOLD_MS,
    releaseMs: DUCK_RELEASE_MS,
    adaptive: false,
  };
}

// Instant rise, slow fall, so loudRef tracks the loud level of whatever is
// playing now and fades after it stops.
function updateLoudReference(level, dt) {
  if (level >= loudRef) {
    loudRef = level;
    return;
  }
  const floor = Math.max(level, REF_MIN);
  loudRef += (floor - loudRef) * (1 - Math.exp(-dt / REF_DECAY_MS));
}

function computeTargetMultiplier(level, tune) {
  if (manualOverride) return 1.0;
  if (!settings.enabled) return 1.0;

  const adjust = loudnessAdjustment();
  let trigger;
  let ceiling;
  if (tune.adaptive) {
    // A quiet track scales both levels down (ducks earlier), a loud one up.
    const scale = Math.pow(2, (adjust / MAX_LUFS_ADJUST) * 0.5);
    trigger = Math.min(0.95, Math.max(ADAPT_TRIGGER_MIN, loudRef * ADAPT_TRIGGER_FRAC) * scale);
    ceiling = Math.min(1, Math.max(trigger + ADAPT_MIN_SPAN, loudRef * ADAPT_CEILING_FRAC * scale));
  } else {
    trigger = Math.max(0, Math.min(0.95, (1 - settings.sensitivity) + adjust));
    ceiling = Math.max(trigger + 0.001, Math.min(1, settings.duckCeiling + adjust));
  }

  if (level <= trigger) return 1.0;

  const range = ceiling - trigger;
  const over = range > 0 ? (level - trigger) / range : 1.0;
  const clamped = Math.max(0, Math.min(1, over));
  return 1.0 - clamped * tune.maxDuck;
}

let lastTickAt = 0;
let holdUntil = 0;
let lastSentMultiplier = 1.0;
let lastSentAt = 0;
let lastDebugAt = 0;

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
  updateLoudReference(level, dt);
  const tune = activeTuning();
  let target = computeTargetMultiplier(level, tune);

  // Hold: every time the signal is at least as loud as what we're already
  // ducked to, restart the hold timer. While it's running, refuse to
  // release — this is what stops the volume pumping back up in the gaps
  // between words. Only applies while ducking is actually active, so the
  // manual-override hotkey / disabling the feature still releases at once.
  if (target < 1.0 && target <= smoothedMultiplier) {
    holdUntil = now + tune.holdMs;
  } else if (target > smoothedMultiplier && settings.enabled && !manualOverride && now < holdUntil) {
    target = smoothedMultiplier;
  }

  const tau = target < smoothedMultiplier ? tune.attackMs : tune.releaseMs;
  smoothedMultiplier += (target - smoothedMultiplier) * (1 - Math.exp(-dt / tau));
  if (Math.abs(target - smoothedMultiplier) < SNAP_EPSILON) smoothedMultiplier = target;

  // Only push when the value changed, and at most every SEND_MIN_MS. A
  // skipped value is not lost: it still differs from lastSentMultiplier, so
  // the next tick sends it. Zero messages once it settles.
  if (smoothedMultiplier !== lastSentMultiplier && now - lastSentAt >= SEND_MIN_MS) {
    lastSentMultiplier = smoothedMultiplier;
    lastSentAt = now;
    onMultiplierChange(smoothedMultiplier);
  }
  if (onDebugTick && now - lastDebugAt >= DEBUG_EVERY_MS) {
    lastDebugAt = now;
    onDebugTick(level, target, smoothedMultiplier);
  }
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
  lastSentAt = 0;
  lastDebugAt = 0;
  holdUntil = 0;
  loudRef = REF_MIN;
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
  loudRef = REF_MIN;
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
    preset: settings.preset,
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
  settings.preset = 'custom';
  saveSettingsToDisk();
  return getSettings();
}

function setDuckCeiling(value) {
  settings.duckCeiling = Math.max(0, Math.min(1, Number(value)));
  settings.preset = 'custom';
  saveSettingsToDisk();
  return getSettings();
}

function setMaxDuck(value) {
  settings.maxDuck = Math.max(0, Math.min(1, Number(value)));
  settings.preset = 'custom';
  saveSettingsToDisk();
  return getSettings();
}

function setPreset(name) {
  if (!PRESET_NAMES.includes(name)) return getSettings();
  settings.preset = name;
  holdUntil = 0;
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
  setPreset,
  setManualOverride,
  setTrackLoudness,
  getAudioSessions,
  setTargetProcesses,
  setExcludedProcessNames,
};
