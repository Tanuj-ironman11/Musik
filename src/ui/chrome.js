// src/ui/chrome.js  (formerly titlebar.js — broadened, see below)
//
// Window chrome that has to exist before any view renders: the custom
// frameless titlebar, and mod loading/execution. Grouped here since both
// are small, both run once on boot, and it beats adding another file to
// an already-crowded /ui.
//
// Titlebar: main.js sets frame:false; this renders the drag region +
// mac-style traffic-light control dots, wires them to window.Musik.window
// (minimize/maximize/close), added in preload.js. Dots are gray by
// default, colored + taller ("bloom") only on individual hover — see
// #titlebar rules in layouts.css for the actual visual.
//
// Mods: mod-loader.js (main process) only discovers mods and serves
// their files over IPC — it deliberately never executes anything. This
// is the other half: inject each enabled mod's CSS, run its JS inside a
// sandboxed iframe (own realm, own globals, never the main process —
// see mod-loader.js header for why that rule exists). Mods get
// window.Musik/window.Aurelius bridged in.

(function () {
  async function initTitlebar() {
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

  // Iframe uses allow-scripts + allow-same-origin: same-origin is what
  // lets us bridge window.Musik/window.Aurelius in below. Not full
  // untrusted-content isolation, but mod code does run in its own JS
  // realm, off the render thread's synchronous call stack, and nowhere
  // near the main process — the actual thing that mattered per the
  // original boot-freeze bug. If you ever load mods from other people,
  // not just your own, tighten this and go through postMessage instead.
  async function loadMods() {
    const mods = await window.Musik?.mods?.list?.();
    if (!mods) return;
    for (const mod of mods) {
      if (mod.enabled === false) continue;
      try {
        if (mod.hasCss) await injectModCSS(mod.id);
        if (mod.hasJs) await runModJS(mod.id);
      } catch (err) {
        console.error(`[Musik] mod "${mod.id}" failed to load:`, err);
      }
    }
  }

  async function injectModCSS(modId) {
    const css = await window.Musik.mods.getFile(modId, 'theme.css');
    if (!css) return;
    const style = document.createElement('style');
    style.dataset.modId = modId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  let modsDirCache = null;
  async function getModsDir() {
    if (modsDirCache) return modsDirCache;
    modsDirCache = await window.Musik.mods.getDir();
    return modsDirCache;
  }

  // Same file:// URL construction as player-ui.js uses for audio playback —
  // encodeURI then unescape '#' back out since it's a valid URI char but
  // module paths can legitimately contain one.
  function toFileUrl(absPath) {
    return 'file:///' + encodeURI(absPath.replace(/\\/g, '/')).replace(/#/g, '%23');
  }

  async function runModJS(modId) {
    const modsDir = await getModsDir();
    if (!modsDir) {
      console.error(`[Musik] mod "${modId}" failed to load: could not resolve mods directory`);
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.sandbox = 'allow-scripts allow-same-origin';
    iframe.dataset.modId = modId;
    document.body.appendChild(iframe);

    iframe.contentWindow.Musik = window.Musik;
    iframe.contentWindow.Aurelius = window.Aurelius;

    // src= instead of textContent: the CSP's script-src has no
    // 'unsafe-inline', so an inline script gets silently blocked. file:
    // IS an allowed source, so pointing at the real file on disk passes
    // as-is — no CSP loosening needed.
    const script = iframe.contentDocument.createElement('script');
    script.src = toFileUrl(`${modsDir}/${modId}/index.js`);
    iframe.contentDocument.body.appendChild(script);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTitlebar();
    loadMods();
  });
})();