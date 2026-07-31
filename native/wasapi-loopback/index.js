// native/wasapi-loopback/index.js
//
// Thin wrapper so callers don't reach into build/Release paths directly.
// Windows-only — require() this only behind a process.platform check.
const path = require('path');
const addon = require(path.join(__dirname, 'build', 'Release', 'wasapi_loopback.node'));

module.exports = {
  start: () => addon.start(),
  stop: () => addon.stop(),
  getLevel: () => addon.getLevel(), // 0.0 - 1.0, smoothed
};
