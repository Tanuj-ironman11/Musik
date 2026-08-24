// native/wasapi-loopback/index.js
//
// Thin wrapper so callers don't reach into build/Release paths directly.
// Windows-only — require() this only behind a process.platform check.
const path = require('path');
const addon = require(path.join(__dirname, 'build', 'Release', 'wasapi_loopback.node'));

module.exports = {
  start: (excludedPids) => addon.start(excludedPids),
  stop: () => addon.stop(),
  getLevel: () => addon.getLevel(), // 0.0 - 1.0, smoothed
  getSessions: () => addon.getSessions(), // [{ pid, name, peak, isSelf }]
  setTargetProcesses: (pids) => addon.setTargetProcesses(pids), // [] = consider everything not excluded
};
