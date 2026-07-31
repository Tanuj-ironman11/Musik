// mods/pastel-glass/index.js
//
// Test/demo mod. Runs sandboxed (iframe/Worker per mod-loader.js) — only
// talks to the app through window.Musik, never touches Node/main process.
//
// Demonstrates: ui.injectElement, events.on('trackupdate'), events.on('play'/'pause').

(function () {
  const TICKER_ID = 'pastel-glass-ticker';

  function renderTickerText(track) {
    if (!track) return '— nothing playing —';
    const artist = track.artist || 'Unknown artist';
    const title = track.title || 'Unknown title';
    return `now playing: ${artist} — ${title}`;
  }

  async function injectTicker() {
    if (!window.Musik?.ui?.injectElement) return;

    const html = `<div id="${TICKER_ID}" class="pastel-glass-idle">— nothing playing —</div>`;
    // targetSelector: '#mod-root' is the dedicated mod injection point
    // defined in index.html for exactly this purpose.
    await window.Musik.ui.injectElement(html, '#mod-root');
  }

  function updateTicker(track) {
    const el = document.getElementById(TICKER_ID);
    if (!el) return;
    el.textContent = renderTickerText(track);
    el.classList.remove('pastel-glass-idle');
  }

  function markIdle() {
    const el = document.getElementById(TICKER_ID);
    if (!el) return;
    el.classList.add('pastel-glass-idle');
  }

  async function init() {
    if (!window.Musik?.events?.on) {
      // Sandbox may load before the bridge is ready — retry shortly rather
      // than assuming init order.
      setTimeout(init, 250);
      return;
    }

    await injectTicker();

    // Seed with current track if one's already playing when the mod loads.
    try {
      const current = await window.Musik.player.getCurrentTrack?.();
      updateTicker(current);
    } catch (_) {
      // no-op — falls back to the idle placeholder text
    }

    window.Musik.events.on('trackupdate', updateTicker);
    window.Musik.events.on('pause', markIdle);
  }

  init();
})();
