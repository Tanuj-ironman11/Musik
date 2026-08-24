// src/ui/eq.js
// 10-band graphic EQ backend. One real filter chain (getEQNodes() in
// player-ui.js) drives all three UI tiers — tiers only change how many
// bands are shown and whether freq/Q are editable, never node count.
// "Off" zeroes every live node without touching stored band values.
//
// window.MusikEQ API:
//   getState() -> { mode, advancedBands, bands: [{freq,gain,q}] x10, lastPreset }
//   setMode('off'|'simple'|'advanced'|'master')
//   setBandCount('advanced', count)   // 5|10 — 'simple' is fixed at 3
//   previewBandGain(bandIndex, dB)    // drag path: live audio + in-memory only, no save/broadcast
//   commitBandGain(bandIndex, dB)     // drag-end: previews + persists + broadcasts
//   setBandGain(bandIndex, dB)        // alias for commitBandGain, non-drag single-shot
//   setBandFreq(bandIndex, hz)        // meaningful in 'master' only
//   setBandQ(bandIndex, q)            // meaningful in 'master' only
//   applyPreset(presetId)
//   listPresets() -> [{ id, label, sparkline }]
//   getVisibleIndices() -> band indices (0-9) for current mode, [] if 'off'
//   getBandLabels() -> labels matching getVisibleIndices() order
//   isBypassed() -> mode === 'off'
//
// Fires 'musik:eq-change' (detail: { state }) on every committed mutation,
// never on previewBandGain.

(function () {
  const STORAGE_KEY = 'musik:eq-state';

  const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_LABELS_10 = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

  // Index sets into the 10-band array for the lower tiers. Q stays at
  // whatever's stored rather than auto-widening per tier. 'simple' is
  // fixed at 3 plain-English bands (Bass/Mid/Treble) — no raw Hz shown,
  // that's what Advanced/Master are for.
  const BAND_SET_3 = { indices: [1, 5, 8], labels: ['Bass', 'Mid', 'Treble'] };
  const BAND_SET_5 = { indices: [0, 2, 4, 6, 9], labels: ['31', '125', '500', '2k', '16k'] };
  const BAND_SET_10 = { indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], labels: EQ_LABELS_10 };

  // Gain-only curves (dB) across the 10 ISO bands. Applying a preset also
  // resets freq/Q to ISO defaults.
  //
  // Real WinAmp 5.1.1.1 default EQ presets, re-sampled from WinAmp's band
  // layout (60/170/310/600/1k/3k/6k/12k/14k/16k) onto ours (ISO 31/62/
  // 125/250/500/1k/2k/4k/8k/16k) via log-frequency interpolation, not
  // nearest-neighbor snapping. Treble Boost's top 3 bands got clamped to
  // our ±12dB ceiling — WinAmp's real curve peaks past +16dB there. No
  // 1:1 "Vocal"/"Acoustic" preset exists in WinAmp's defaults; relabeled
  // from the closest real matches ("Live" and "Soft").
  const PRESETS = {
    flat:        { label: 'Default',        gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    bassBoost:   { label: 'Bass Boost',     gains: [9.6, 9.6, 9.6, 9.6, 6.7, 1.6, -1.9, -5.7, -9, -11.2] },
    trebleBoost: { label: 'Treble Boost',   gains: [-9.6, -9.6, -9.6, -9.6, -5.5, 2.4, 8, 12, 12, 12] },
    vocal:       { label: 'Vocal',          gains: [-4.8, -4.6, -1.4, 2.6, 5.2, 5.6, 5.6, 4.9, 3.3, 2.4] },
    rock:        { label: 'Rock',           gains: [8, 7.9, 5.7, -1.9, -7.3, -3.2, 1.3, 6, 9.8, 11.2] },
    pop:         { label: 'Pop',            gains: [-1.6, -1.4, 2.9, 6.3, 7.8, 5.6, 2.1, -1, -2.4, -1.6] },
    electronic:  { label: 'Electronic',     gains: [8, 7.9, 6.3, 2, -4.1, -4.8, -1.8, 3.3, 8.7, 8.8] },
    acoustic:    { label: 'Acoustic',       gains: [4.8, 4.7, 2.5, 0.6, -1.7, 0, 2.5, 5.7, 8.7, 12] },
  };


  function defaultBands() {
    return EQ_FREQUENCIES.map((freq) => ({ freq, gain: 0, q: 1.0 }));
  }

  function defaultState() {
    return { mode: 'off', advancedBands: 10, bands: defaultBands(), lastPreset: 'flat' };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      // Shallow-merge, defensive against a partial/corrupt older shape.
      return {
        mode: ['off', 'simple', 'advanced', 'master'].includes(parsed.mode) ? parsed.mode : base.mode,
        advancedBands: [5, 10].includes(parsed.advancedBands) ? parsed.advancedBands : base.advancedBands,
        lastPreset: typeof parsed.lastPreset === 'string' ? parsed.lastPreset : base.lastPreset,
        bands: Array.isArray(parsed.bands) && parsed.bands.length === 10
          ? parsed.bands.map((b, i) => ({
              freq: typeof b?.freq === 'number' ? b.freq : EQ_FREQUENCIES[i],
              gain: typeof b?.gain === 'number' ? b.gain : 0,
              q: typeof b?.q === 'number' ? b.q : 1.0,
            }))
          : base.bands,
      };
    } catch (_) {
      return defaultState();
    }
  }

  let state = loadState();

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function broadcastChange() {
    window.dispatchEvent(new CustomEvent('musik:eq-change', { detail: { state: getState() } }));
  }

  function applyToLiveNodes() {
    const nodes = window.MusikPlayerUI?.getEQNodes?.();
    if (!nodes || !nodes.length) return;
    const bypassed = state.mode === 'off';
    nodes.forEach((node, i) => {
      const band = state.bands[i];
      if (!band || !node) return;
      node.frequency.value = band.freq;
      node.Q.value = band.q;
      node.gain.value = bypassed ? 0 : band.gain;
    });
  }

  function commit() {
    saveState();
    applyToLiveNodes();
    broadcastChange();
  }

  function getState() {
    return {
      mode: state.mode,
      advancedBands: state.advancedBands,
      lastPreset: state.lastPreset,
      bands: state.bands.map((b) => ({ ...b })),
    };
  }

  function setMode(mode) {
    if (!['off', 'simple', 'advanced', 'master'].includes(mode)) return;
    state.mode = mode;
    commit();
  }

  function setBandCount(tier, count) {
    if (tier === 'advanced' && [5, 10].includes(count)) {
      state.advancedBands = count;
      commit();
    }
  }

  // Drag path — updates the live filter node + in-memory value immediately,
  // but skips localStorage + broadcast (broadcasting every pointermove
  // would make settings.js tear down and rebuild the band UI mid-drag,
  // killing pointer capture). Call commitBandGain once the drag ends.
  function previewBandGain(index, dB) {
    if (!state.bands[index]) return;
    const clamped = Math.max(-12, Math.min(12, dB));
    state.bands[index].gain = clamped;
    const nodes = window.MusikPlayerUI?.getEQNodes?.();
    const node = nodes?.[index];
    if (node) node.gain.value = state.mode === 'off' ? 0 : clamped;
    return clamped;
  }

  function commitBandGain(index, dB) {
    previewBandGain(index, dB);
    state.lastPreset = null; // manual tweak no longer matches whatever preset was last applied
    saveState();
    broadcastChange();
  }

  // Single-shot alias for anything that isn't a drag.
  function setBandGain(index, dB) {
    commitBandGain(index, dB);
  }

  function setBandFreq(index, hz) {
    if (!state.bands[index]) return;
    state.bands[index].freq = Math.max(20, Math.min(20000, hz));
    state.lastPreset = null;
    commit();
  }

  function setBandQ(index, q) {
    if (!state.bands[index]) return;
    state.bands[index].q = Math.max(0.1, Math.min(10, q));
    state.lastPreset = null;
    commit();
  }

  function applyPreset(presetId) {
    const preset = PRESETS[presetId];
    if (!preset) return;
    state.bands = EQ_FREQUENCIES.map((freq, i) => ({ freq, gain: preset.gains[i], q: 1.0 }));
    state.lastPreset = presetId;
    commit();
  }

  const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  function sparkline(gains) {
    return gains.map((g) => {
      const t = (g + 12) / 24; // -12..12 -> 0..1
      const idx = Math.max(0, Math.min(SPARK_BLOCKS.length - 1, Math.round(t * (SPARK_BLOCKS.length - 1))));
      return SPARK_BLOCKS[idx];
    }).join('');
  }

  function listPresets() {
    return Object.keys(PRESETS).map((id) => ({
      id,
      label: PRESETS[id].label,
      sparkline: sparkline(PRESETS[id].gains),
    }));
  }

  function currentBandSet() {
    if (state.mode === 'off') return { indices: [], labels: [] };
    if (state.mode === 'simple') return BAND_SET_3;
    if (state.mode === 'advanced') return state.advancedBands === 5 ? BAND_SET_5 : BAND_SET_10;
    return BAND_SET_10; // master
  }

  function getVisibleIndices() {
    return currentBandSet().indices.slice();
  }

  function getBandLabels() {
    return currentBandSet().labels.slice();
  }

  function isBypassed() {
    return state.mode === 'off';
  }

  window.Musik?.events?.on('audiograph-rebuilt', applyToLiveNodes);
  // Defensive: apply immediately in case a graph already exists.
  applyToLiveNodes();

  window.MusikEQ = {
    getState,
    setMode,
    setBandCount,
    previewBandGain,
    commitBandGain,
    setBandGain,
    setBandFreq,
    setBandQ,
    applyPreset,
    listPresets,
    getVisibleIndices,
    getBandLabels,
    isBypassed,
  };
})();
