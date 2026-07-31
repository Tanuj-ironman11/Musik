// src/core/audio-engine.js
//
// Main-process side of the audio engine. The actual Web Audio graph
// (MediaElementAudioSourceNode -> AnalyserNode -> destination) lives in the
// renderer, since Web Audio API isn't available in the main process. This
// module tracks minimal playback state so IPC calls have something to read,
// and is the seam the renderer reports state back through.
//
// Kept intentionally bare for bare-boot sanity check — fill in as the
// renderer-side player-ui.js / audio graph comes online.

let state = {
  isPlaying: false,
  currentTrack: null,
  volume: 1.0,
  positionSeconds: 0,
};

function play(trackId) {
  state.isPlaying = true;
  if (trackId) state.currentTrack = trackId;
  return state;
}

function pause() {
  state.isPlaying = false;
  return state;
}

function seek(seconds) {
  state.positionSeconds = seconds;
  return state;
}

function setVolume(value) {
  state.volume = Math.max(0, Math.min(1, value));
  return state;
}

function getState() {
  return { ...state };
}

function getCurrentTrack() {
  return state.currentTrack;
}

module.exports = {
  play,
  pause,
  seek,
  setVolume,
  getState,
  getCurrentTrack,
};
