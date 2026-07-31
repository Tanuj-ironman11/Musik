// src/ui/titlebar.js
//
// Custom frameless-window titlebar. main.js sets frame:false; this renders
// the drag region + mac-style traffic-light control dots and wires them to
// window.Musik.window (minimize/maximize/close), added in preload.js.
//
// Dots are gray by default, colored + taller ("bloom") only on individual
// hover — see #titlebar rules in layouts.css for the actual visual.

(function () {
  async function init() {
    const titlebar = document.getElementById('titlebar');
    if (!titlebar) {
      console.error('[Musik] #titlebar not found in DOM');
      return;
    }

    const platform = (await window.Musik?.window?.platform?.()) || 'win32';
    const isMac = platform === 'darwin';
    titlebar.classList.add(isMac ? 'platform-mac' : 'platform-win');

    titlebar.innerHTML = `
      <div class="titlebar-drag-region"></div>
      <span id="titlebar-app-name">Musik</span>
      <div class="window-controls">
        <button class="control-dot close" title="Close">
          <svg class="control-icon" viewBox="0 0 10 10" fill="none"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
        <button class="control-dot minimize" title="Minimize">
          <svg class="control-icon" viewBox="0 0 10 10" fill="none"><path d="M1 5H9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
        <button class="control-dot maximize" title="Maximize">
          <svg class="control-icon" viewBox="0 0 10 10" fill="none"><rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>
    `;

    titlebar.querySelector('.control-dot.close')
      .addEventListener('click', () => window.Musik.window.close());
    titlebar.querySelector('.control-dot.minimize')
      .addEventListener('click', () => window.Musik.window.minimize());
    titlebar.querySelector('.control-dot.maximize')
      .addEventListener('click', () => window.Musik.window.maximize());
  }

  document.addEventListener('DOMContentLoaded', init);
})();