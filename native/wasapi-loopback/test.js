// native/wasapi-loopback/test.js
//
// Run this directly with plain Node (not Electron) to sanity-check the
// addon before it touches the app at all:
//   node test.js
//
// Play something audible on your system (music, YouTube, a game) while
// this runs — you should see the level climb above 0 within a second or
// two. Ctrl+C to stop.

const wasapi = require('./index.js');

console.log('Starting WASAPI loopback capture... play some audio now.');
wasapi.start();

const interval = setInterval(() => {
  const level = wasapi.getLevel();
  const bars = '#'.repeat(Math.round(level * 40));
  console.log(`level: ${level.toFixed(3)}  ${bars}`);
}, 150);

process.on('SIGINT', () => {
  clearInterval(interval);
  wasapi.stop();
  console.log('\nStopped.');
  process.exit(0);
});
