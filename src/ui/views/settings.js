// src/ui/views/settings.js
// Settings tab. Sections are separated into their own render functions so
// new prefs slot in without touching unrelated ones.

window.MusikViews = window.MusikViews || {};

// Shared with app.js. Broadcast via 'musik:layout-change' so an
// already-open app.js instance updates live instead of needing a reload.
const LAYOUT_MODE_KEY = 'musikLayoutMode';

function getLayoutMode() {
  return localStorage.getItem(LAYOUT_MODE_KEY) || 'dynamic';
}
function broadcastLayoutChange() {
  window.dispatchEvent(new CustomEvent('musik:layout-change', {
    detail: { mode: getLayoutMode() },
  }));
}

// 3D visualizer quality — visualizer.js is the source of truth for
// applying this live (window.MusikVisualizer.setQuality), this just
// persists the pref and broadcasts so an already-open Fullscreen view
// picks it up without needing a reload. Kept out of the topbar per explicit
// call: fullscreen stays uncluttered, quality lives in Settings only.
const VIS_QUALITY_KEY = 'musik:visualizer-quality';

function getVisQuality() {
  return localStorage.getItem(VIS_QUALITY_KEY) || 'medium';
}
function broadcastVisualizerChange(detail) {
  window.dispatchEvent(new CustomEvent('musik:visualizer-settings-change', { detail }));
}

// 3D blob reactivity. visualizer.js reads this straight out of localStorage
// every frame (draw3d), so writing it here is enough — no broadcast event
// needed for it to take effect live.
const VIS_SENSITIVITY_KEY = 'musik_vis_sensitivity';

function getVisSensitivityPercent() {
  const raw = parseFloat(localStorage.getItem(VIS_SENSITIVITY_KEY));
  return Number.isFinite(raw) ? Math.round(raw * 100) : 100;
}

// "Custom effects" — Fresnel rim lighting + dither, both uniform-gated in
// visualizer.js so toggling applies live with no rebuild. Master gates both
// subs; each sub defaults to on so flipping the master shows both, then
// either can be switched off individually to A/B against a clean baseline.
const CUSTOM_FX_KEY = 'musik:visualizer-customfx';
const FRESNEL_KEY = 'musik:visualizer-fresnel';
const DITHER_KEY = 'musik:visualizer-dither';

function getCustomFxOn() {
  return localStorage.getItem(CUSTOM_FX_KEY) === 'on';
}
function getFresnelOn() {
  return localStorage.getItem(FRESNEL_KEY) !== 'off';
}
function getDitherOn() {
  return localStorage.getItem(DITHER_KEY) !== 'off';
}

// "Always on top" needs window.Musik.miniplayer.setAlwaysOnTop() —
// preload.js/main.js don't expose it yet. Saves the pref, no visible
// effect until that IPC surface exists.
const MINI_ALWAYS_ON_TOP_KEY = 'musikMiniAlwaysOnTop';

function getMiniAlwaysOnTop() {
  return localStorage.getItem(MINI_ALWAYS_ON_TOP_KEY) !== 'false';
}

// Own Last.fm API key/secret. localStorage only — never written to a repo
// file. Pushed into the main process via setCredentials() on change.
const LASTFM_API_KEY_KEY = 'musikLastfmApiKey';
const LASTFM_API_SECRET_KEY = 'musikLastfmApiSecret';

function getStoredLastfmCreds() {
  return {
    apiKey: localStorage.getItem(LASTFM_API_KEY_KEY) || '',
    apiSecret: localStorage.getItem(LASTFM_API_SECRET_KEY) || '',
  };
}

function setStoredLastfmCreds(apiKey, apiSecret) {
  if (apiKey) localStorage.setItem(LASTFM_API_KEY_KEY, apiKey);
  else localStorage.removeItem(LASTFM_API_KEY_KEY);
  if (apiSecret) localStorage.setItem(LASTFM_API_SECRET_KEY, apiSecret);
  else localStorage.removeItem(LASTFM_API_SECRET_KEY);
}

async function syncLastfmCredsToMain() {
  const { apiKey, apiSecret } = getStoredLastfmCreds();
  if (!apiKey && !apiSecret) return;
  await window.Musik?.scrobble?.setCredentials?.({ apiKey, apiSecret });
}

// Exposed so app.js can call this once on app boot — right now it only
// ever ran when the Settings view itself rendered, meaning a saved key
// wasn't actually pushed into the scrobbler until you opened Settings that
// session. If you played a track first, scrobbling would fail with a
// misleading "API key missing" error despite the key being saved fine.
window.MusikViews.syncLastfmCredsToMain = syncLastfmCredsToMain;

function layoutCardHTML(mode, title, desc) {
  if (mode === 'topbar') {
    return `
      <button type="button" class="layout-card" data-nav-mode="${mode}">
        <div class="layout-mock layout-mock--topbar">
          <div class="layout-mock-bar">
            <span class="layout-mock-dot"></span>
            <span class="layout-mock-dot"></span>
            <span class="layout-mock-dot"></span>
            <span class="layout-mock-bar-spacer"></span>
            <span class="layout-mock-pill"></span>
          </div>
          <div class="layout-mock-content layout-mock-content--full">
            <span class="layout-mock-block"></span>
            <span class="layout-mock-block"></span>
          </div>
        </div>
        <span class="layout-card-title">${title}</span>
        <span class="layout-card-desc">${desc}</span>
      </button>
    `;
  }

  const railClass = mode === 'pinned'
    ? 'layout-mock-rail layout-mock-rail--expanded'
    : 'layout-mock-rail layout-mock-rail--dynamic';

  return `
    <button type="button" class="layout-card" data-nav-mode="${mode}">
      <div class="layout-mock">
        <div class="${railClass}">
          <span class="layout-mock-dot"></span>
          <span class="layout-mock-dot"></span>
          <span class="layout-mock-dot"></span>
          ${mode === 'pinned' ? '<span class="layout-mock-line"></span><span class="layout-mock-line"></span><span class="layout-mock-line"></span>' : ''}
        </div>
        ${mode === 'dynamic' ? '<div class="layout-mock-hover-hint"></div>' : ''}
        <div class="layout-mock-content">
          <span class="layout-mock-block"></span>
          <span class="layout-mock-block"></span>
        </div>
      </div>
      <span class="layout-card-title">${title}</span>
      <span class="layout-card-desc">${desc}</span>
    </button>
  `;
}

function formatRelativeTime(ms) {
  if (!ms) return null;
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString();
}

function lastfmApiCredsHTML() {
  const { apiKey, apiSecret } = getStoredLastfmCreds();
  return `
    <div class="settings-row settings-row--stack">
      <div class="settings-row-label">
        <span class="settings-row-name">Your own API key (optional)</span>
        <span class="settings-row-desc">Stored only in this browser's local storage, never written to a file on disk. Leave blank to use the shared default key.</span>
      </div>
      <div class="settings-row-control settings-row-control--inline">
        <input type="password" id="settings-lastfm-apikey-input" placeholder="API key" autocomplete="off" spellcheck="false" value="${apiKey}" />
        <input type="password" id="settings-lastfm-apisecret-input" placeholder="Shared secret" autocomplete="off" spellcheck="false" value="${apiSecret}" />
        <button id="settings-lastfm-creds-save" class="btn">Save</button>
        ${(apiKey || apiSecret) ? '<button id="settings-lastfm-creds-clear" class="btn btn--danger">Clear</button>' : ''}
      </div>
      <span id="settings-lastfm-creds-status" class="settings-row-desc" hidden></span>
    </div>
  `;
}

function lastfmSectionHTML(s) {
  if (s.connected) {
    const lastScrobbleText = formatRelativeTime(s.lastScrobbleAt);
    return `
      <div class="settings-row">
        <div class="settings-row-label">
          <span class="settings-row-name">Connected as ${s.username}</span>
          <span class="settings-row-desc">${lastScrobbleText ? `Last scrobble: ${lastScrobbleText}` : 'No scrobbles yet.'}</span>
        </div>
        <div class="settings-row-control">
          <button id="settings-lastfm-disconnect" class="btn btn--danger">Disconnect</button>
        </div>
      </div>
      ${lastfmApiCredsHTML()}
    `;
  }

  const { apiKey } = getStoredLastfmCreds();
  const hasKey = !!apiKey;

  return `
    <div class="settings-row">
      <div class="settings-row-label">
        <span class="settings-row-name">Scrobbling</span>
        <span class="settings-row-desc">${hasKey ? 'Connect your Last.fm account to scrobble plays automatically.' : 'Add your API key below first, then connect.'}</span>
      </div>
      <div class="settings-row-control">
        <button id="settings-lastfm-connect" class="btn" ${hasKey ? '' : 'disabled'}>Connect</button>
      </div>
    </div>
    <div class="settings-row settings-row--stack" id="settings-lastfm-token-row" hidden>
      <div class="settings-row-label">
        <span class="settings-row-name">Approved in your browser?</span>
        <span class="settings-row-desc">Once you've clicked "Yes, Allow Access" on the Last.fm page, come back and confirm below.</span>
      </div>
      <div class="settings-row-control settings-row-control--inline">
        <button id="settings-lastfm-token-submit" class="btn">I've approved it</button>
      </div>
      <span id="settings-lastfm-error" class="settings-row-error" hidden></span>
    </div>
    ${lastfmApiCredsHTML()}
  `;
}

function modRowHTML(mod) {
  return `
    <div class="settings-row" data-mod-id="${mod.id}">
      <div class="settings-row-label">
        <span class="settings-row-name">${mod.name}</span>
        <span class="settings-row-desc">v${mod.version} — ${mod.author}</span>
      </div>
      <div class="settings-row-control">
        <input type="checkbox" class="settings-mod-toggle" data-mod-id="${mod.id}" ${mod.enabled ? 'checked' : ''} />
      </div>
    </div>
  `;
}

async function refreshModsList() {
  const listEl = document.getElementById('settings-mods-list');
  if (!listEl) return;
  const mods = (await window.Musik?.mods?.list?.()) ?? [];
  listEl.innerHTML = mods.length
    ? mods.map(modRowHTML).join('')
    : '<div class="settings-row"><div class="settings-row-label"><span class="settings-row-desc">No mods found.</span></div></div>';

  listEl.querySelectorAll('.settings-mod-toggle').forEach((toggle) => {
    toggle.addEventListener('change', async (e) => {
      await window.Musik?.mods?.setEnabled?.(e.target.dataset.modId, e.target.checked);
    });
  });
}

// Settings view re-renders its whole DOM via main.innerHTML on every visit.
// Element-scoped listeners die with their elements naturally, but anything
// bound to document/window (custom-select outside-click, resize, the
// musik:eq-change bus) outlives that and stacked up one extra copy per
// visit. This controller is aborted at the top of every render so the
// previous visit's listeners are torn down before the new ones go on.
let settingsViewAbortController = null;

window.MusikViews['settings'] = async function renderSettings(main) {
  settingsViewAbortController?.abort();
  settingsViewAbortController = new AbortController();
  const { signal } = settingsViewAbortController;

  const duckSettings = (await window.Musik?.gameDuck?.getSettings?.()) ?? { available: false, enabled: false, sensitivity: 0.5, duckCeiling: 0.4, maxDuck: 0.6 };
  const scrobblerSettings = (await window.Musik?.scrobble?.getSettings?.()) ?? { connected: false, username: null, enabled: true, usingCustomApiKey: false, lastScrobbleAt: null };

  main.innerHTML = `
    <div class="settings-page">
      <h1 class="settings-title">Settings</h1>

      <section class="settings-section" id="settings-playback">
        <h2 class="settings-section-title">Playback</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Default volume</span>
            <span class="settings-row-desc">Volume applied on launch, before you touch the slider.</span>
          </div>
          <div class="settings-row-control">
            <input type="range" id="settings-default-volume" min="0" max="100"
              value="${Math.round((window.MusikPlayerUI?.getVolume?.() ?? 1) * 100)}" />
            <span id="settings-default-volume-value" class="settings-row-value"></span>
          </div>
        </div>
      </section>

      <section class="settings-section" id="settings-layout">
        <h2 class="settings-section-title">Layout</h2>
        <div class="settings-row settings-row--stack">
          <div class="settings-row-label">
            <span class="settings-row-name">Navigation</span>
            <span class="settings-row-desc">Choose how the sidebar behaves — or turn it into a top bar.</span>
          </div>
        </div>
        <div class="layout-grid" id="layout-nav-grid">
          ${layoutCardHTML('dynamic', 'Dynamic', 'Hidden until you hover the edge.')}
          ${layoutCardHTML('pinned', 'Pinned', 'Sidebar stays expanded, always visible.')}
          ${layoutCardHTML('topbar', 'Top Bar', 'Sidebar becomes a bar across the top.')}
        </div>
      </section>

      <section class="settings-section" id="settings-miniplayer">
        <h2 class="settings-section-title">Miniplayer</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Always on top</span>
            <span class="settings-row-desc">Keep the miniplayer floating above other windows. Off = it behaves like a normal window.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-mini-always-on-top" ${getMiniAlwaysOnTop() ? 'checked' : ''} />
          </div>
        </div>
      </section>

      <section class="settings-section" id="settings-eq">
        <h2 class="settings-section-title">Equalizer</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Mode</span>
            <span class="settings-row-desc">Off is flat, zero effect on playback. Simple/Advanced are gain-only sliders. Master unlocks frequency and Q per band.</span>
          </div>
          <div class="settings-row-control">
            <div class="custom-select" id="settings-eq-mode">
              <button type="button" class="custom-select-trigger">
                <span class="custom-select-trigger-label">Off</span>
                <svg class="select-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              <div class="custom-select-options">
                <div class="custom-option" data-value="off">Off</div>
                <div class="custom-option" data-value="simple">Simple</div>
                <div class="custom-option" data-value="advanced">Advanced</div>
                <div class="custom-option" data-value="master">Master</div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-row" id="settings-eq-advanced-count-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Bands</span>
          </div>
          <div class="settings-row-control">
            <div class="custom-select" id="settings-eq-advanced-count">
              <button type="button" class="custom-select-trigger">
                <span class="custom-select-trigger-label">5-band</span>
                <svg class="select-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              <div class="custom-select-options">
                <div class="custom-option" data-value="5">5-band</div>
                <div class="custom-option" data-value="10">10-band</div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-row settings-row--stack" id="settings-eq-presets-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Presets</span>
            <span class="settings-row-desc">Applies to the underlying 10 bands, so it shows correctly no matter which tier you're viewing.</span>
          </div>
          <div class="eq-preset-grid" id="settings-eq-presets"></div>
        </div>
        <div class="settings-row settings-row--stack" id="settings-eq-bands-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Bands</span>
          </div>
          <div class="eq-bands-grid" id="settings-eq-bands"></div>
        </div>
      </section>

      <section class="settings-section" id="settings-visualizer">
        <h2 class="settings-section-title">Visualizer</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Quality</span>
            <span class="settings-row-desc">Low disables extra fill/glow rendering and thins point density for weaker hardware. High turns it all up. Ultra adds supersampling on top of that.</span>
          </div>
          <div class="settings-row-control">
            <div class="custom-select" id="settings-vis-quality">
              <button type="button" class="custom-select-trigger">
                <span class="custom-select-trigger-label">Low</span>
                <svg class="select-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              <div class="custom-select-options">
                <div class="custom-option" data-value="low">Low</div>
                <div class="custom-option" data-value="medium">Medium</div>
                <div class="custom-option" data-value="high">High</div>
                <div class="custom-option" data-value="ultra">Ultra</div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Reactivity</span>
            <span class="settings-row-desc">How much the 3D blob deforms in response to audio. Lower this if it feels too jumpy.</span>
          </div>
          <div class="settings-row-control">
            <input type="range" id="settings-vis-sensitivity" class="range-fill" min="25" max="200"
              value="${getVisSensitivityPercent()}" />
            <span id="settings-vis-sensitivity-value" class="settings-row-value"></span>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Custom effects</span>
            <span class="settings-row-desc">Fresnel rim lighting and dither — bigger visual changes than the quality tiers above. Off by default so you can compare against the clean look first.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-vis-customfx" ${getCustomFxOn() ? 'checked' : ''} />
          </div>
        </div>
        <div class="settings-row settings-row--sub" id="settings-vis-fresnel-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Fresnel rim lighting</span>
            <span class="settings-row-desc">Glowing edge along the blob's silhouette, brightest at grazing angles.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-vis-fresnel" ${getFresnelOn() ? 'checked' : ''} ${getCustomFxOn() ? '' : 'disabled'} />
          </div>
        </div>
        <div class="settings-row settings-row--sub" id="settings-vis-dither-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Dither</span>
            <span class="settings-row-desc">Adds a faint texture to smooth out banding in the bloom glow.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-vis-dither" ${getDitherOn() ? 'checked' : ''} ${getCustomFxOn() ? '' : 'disabled'} />
          </div>
        </div>
      </section>

      <section class="settings-section" id="settings-library">
        <h2 class="settings-section-title">Library</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Auto-rescan</span>
            <span class="settings-row-desc">Automatically rescans all watched folders on launch and on this interval. Set to Off to only scan manually.</span>
          </div>
          <div class="settings-row-control">
            <div class="custom-select" id="settings-rescan-interval">
              <button type="button" class="custom-select-trigger">
                <span class="custom-select-trigger-label">Off</span>
                <svg class="select-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              <div class="custom-select-options">
                <div class="custom-option" data-value="0">Off</div>
                <div class="custom-option" data-value="15">Every 15 min</div>
                <div class="custom-option" data-value="30">Every 30 min</div>
                <div class="custom-option" data-value="60">Every 60 min</div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Rescan now</span>
            <span class="settings-row-desc">Force an immediate rescan of all watched folders.</span>
          </div>
          <div class="settings-row-control">
            <button type="button" id="settings-rescan-now" class="btn">Rescan library</button>
            <span id="settings-rescan-status" class="settings-row-value"></span>
          </div>
        </div>
      </section>

      <section class="settings-section" id="settings-mods">
        <h2 class="settings-section-title">Mods</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Installed mods</span>
            <span class="settings-row-desc">Drop mod folders into the mods directory, then rescan.</span>
          </div>
          <div class="settings-row-control">
            <button type="button" id="settings-mods-open-folder" class="btn">Open mods folder</button>
            <button type="button" id="settings-mods-rescan" class="btn">Rescan mods</button>
          </div>
        </div>
        <div id="settings-mods-list"></div>
      </section>

      <section class="settings-section" id="settings-game-mode">
        <h2 class="settings-section-title">Game mode</h2>
        ${!duckSettings.available ? `
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Reactive volume ducking</span>
              <span class="settings-row-desc">Not available on this platform (Windows only).</span>
            </div>
          </div>
        ` : `
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Reactive volume ducking</span>
              <span class="settings-row-desc">Automatically lowers Musik's volume when system audio (games, etc.) gets loud. Ctrl+Shift+D to override anytime.</span>
            </div>
            <div class="settings-row-control">
              <input type="checkbox" id="settings-duck-enabled" ${duckSettings.enabled ? 'checked' : ''} />
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Sensitivity</span>
              <span class="settings-row-desc">Higher = ducks at quieter system audio.</span>
            </div>
            <div class="settings-row-control">
              <input type="range" id="settings-duck-sensitivity" min="0" max="100"
                value="${Math.round(duckSettings.sensitivity * 100)}" />
              <span id="settings-duck-sensitivity-value" class="settings-row-value"></span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Duck ceiling</span>
              <span class="settings-row-desc">System audio level treated as "fully loud." Real game audio rarely peaks near 100% — lower this if ducking feels too weak, raise it if it's ducking on quiet sounds.</span>
            </div>
            <div class="settings-row-control">
              <input type="range" id="settings-duck-ceiling" min="1" max="100"
                value="${Math.round(duckSettings.duckCeiling * 100)}" />
              <span id="settings-duck-ceiling-value" class="settings-row-value"></span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Max duck amount</span>
              <span class="settings-row-desc">How much volume gets removed at peak system audio.</span>
            </div>
            <div class="settings-row-control">
              <input type="range" id="settings-duck-max" min="0" max="100"
                value="${Math.round(duckSettings.maxDuck * 100)}" />
              <span id="settings-duck-max-value" class="settings-row-value"></span>
            </div>
          </div>
          <div class="settings-row" id="settings-duck-meter-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Live meter</span>
              <span class="settings-row-desc">Play something loud in another app to test. Only updates while ducking is enabled.</span>
            </div>
            <div class="settings-row-control settings-row-control--inline">
              <span id="settings-duck-meter-level" class="settings-row-value">level: —</span>
              <span id="settings-duck-meter-mult" class="settings-row-value">volume: —</span>
            </div>
          </div>
        `}
      </section>

      <section class="settings-section" id="settings-scrobbling">
        <h2 class="settings-section-title">Last.fm</h2>
        ${lastfmSectionHTML(scrobblerSettings)}
      </section>

      <section class="settings-section" id="settings-debug">
        <h2 class="settings-section-title">Debug</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">System check</span>
            <span class="settings-row-desc">Bridge status, manual file playback test.</span>
          </div>
          <div class="settings-row-control">
            <button id="settings-open-system-check" class="btn">Open</button>
          </div>
        </div>
      </section>
    </div>
  `;

  const volumeSlider = document.getElementById('settings-default-volume');
  const volumeValue = document.getElementById('settings-default-volume-value');

  function paintVolumeValue() {
    volumeValue.textContent = `${volumeSlider.value}%`;
  }
  paintVolumeValue();

  volumeSlider.addEventListener('input', () => {
    paintVolumeValue();
    window.MusikPlayerUI?.setVolume?.(Number(volumeSlider.value) / 100);
  });

  document.getElementById('settings-open-system-check').addEventListener('click', () => {
    location.hash = '#/system-check';
  });

  document.getElementById('settings-mini-always-on-top').addEventListener('change', (e) => {
    localStorage.setItem(MINI_ALWAYS_ON_TOP_KEY, String(e.target.checked));
    window.Musik?.miniplayer?.setAlwaysOnTop?.(e.target.checked);
  });

  const rescanIntervalSelect = document.getElementById('settings-rescan-interval');
  const rescanNowBtn = document.getElementById('settings-rescan-now');
  const rescanStatus = document.getElementById('settings-rescan-status');

  const rescanIntervalCustomSelect = initCustomSelect(rescanIntervalSelect, (value) => {
    window.Musik?.library?.setRescanInterval?.(Number(value));
  });

  window.Musik?.library?.getRescanSettings?.().then((settings) => {
    rescanIntervalCustomSelect?.setValue(String(settings?.intervalMinutes ?? 0));
  });

  rescanNowBtn?.addEventListener('click', async () => {
    rescanNowBtn.disabled = true;
    rescanStatus.textContent = 'Scanning…';
    try {
      await window.Musik?.library?.rescanAll?.();
      rescanStatus.textContent = 'Done';
    } catch (err) {
      rescanStatus.textContent = 'Failed';
      console.warn('[Musik] rescan failed:', err);
    } finally {
      rescanNowBtn.disabled = false;
      setTimeout(() => { rescanStatus.textContent = ''; }, 3000);
    }
  });

  const visQualitySelect = document.getElementById('settings-vis-quality');

  const visQualityCustomSelect = initCustomSelect(visQualitySelect, (value) => {
    localStorage.setItem(VIS_QUALITY_KEY, value);
    window.MusikVisualizer?.setQuality?.(value);
    broadcastVisualizerChange({ quality: value });
  });
  visQualityCustomSelect?.setValue(window.MusikVisualizer?.getQuality?.() ?? getVisQuality());

  const sensSlider2 = document.getElementById('settings-vis-sensitivity');
  const sensValue2 = document.getElementById('settings-vis-sensitivity-value');
  const paintVisSensitivity = () => {
    sensValue2.textContent = `${sensSlider2.value}%`;
    sensSlider2.style.setProperty('--fill', `${(sensSlider2.value - sensSlider2.min) / (sensSlider2.max - sensSlider2.min) * 100}%`);
  };
  paintVisSensitivity();
  sensSlider2.addEventListener('input', () => {
    paintVisSensitivity();
    localStorage.setItem(VIS_SENSITIVITY_KEY, String(Number(sensSlider2.value) / 100));
  });

  const customFxCheckbox = document.getElementById('settings-vis-customfx');
  const fresnelCheckbox = document.getElementById('settings-vis-fresnel');
  const ditherCheckbox = document.getElementById('settings-vis-dither');
  const fresnelRow = document.getElementById('settings-vis-fresnel-row');
  const ditherRow = document.getElementById('settings-vis-dither-row');

  const paintSubFxState = (on) => {
    [fresnelCheckbox, ditherCheckbox].forEach((cb) => { if (cb) cb.disabled = !on; });
    [fresnelRow, ditherRow].forEach((row) => row?.classList.toggle('settings-row--sub-disabled', !on));
  };
  paintSubFxState(getCustomFxOn());

  customFxCheckbox?.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem(CUSTOM_FX_KEY, on ? 'on' : 'off');
    paintSubFxState(on);
    window.MusikVisualizer?.setCustomFx?.(on);
    broadcastVisualizerChange({ customFx: on });
  });

  fresnelCheckbox?.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem(FRESNEL_KEY, on ? 'on' : 'off');
    window.MusikVisualizer?.setFresnel?.(on);
    broadcastVisualizerChange({ fresnel: on });
  });

  ditherCheckbox?.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem(DITHER_KEY, on ? 'on' : 'off');
    window.MusikVisualizer?.setDither?.(on);
    broadcastVisualizerChange({ dither: on });
  });

  // ── Equalizer ─────────────────────────────────────────────────────────
  // window.MusikEQ (eq.js) owns state/persistence/live-node wiring; this
  // block only renders and reads/writes through its API.

  const eqModeSelect = document.getElementById('settings-eq-mode');
  const eqAdvancedCountRow = document.getElementById('settings-eq-advanced-count-row');
  const eqAdvancedCountSelect = document.getElementById('settings-eq-advanced-count');
  const eqPresetsRow = document.getElementById('settings-eq-presets-row');
  const eqPresetsWrap = document.getElementById('settings-eq-presets');
  const eqBandsRow = document.getElementById('settings-eq-bands-row');
  const eqBandsWrap = document.getElementById('settings-eq-bands');

  // Minimal, self-contained wiring for the app's existing .custom-select
  // component (styled in tokens.css, previously unused by any JS) — click
  // trigger to open, click an option to pick it, click outside to close.
  function initCustomSelect(root, onChange) {
    if (!root) return null;
    const trigger = root.querySelector('.custom-select-trigger');
    const label = root.querySelector('.custom-select-trigger-label');
    const optionsPanel = root.querySelector('.custom-select-options');
    const options = root.querySelectorAll('.custom-option');

    // .settings-section has its own backdrop-filter, which creates a
    // separate stacking context per section. An absolutely-positioned
    // options panel is trapped inside its own section's context — no
    // z-index can lift it above whichever section comes next in the DOM.
    // Moving the panel to <body> and position:fixed-ing it off the
    // trigger's live bounding rect escapes the trap entirely.
    optionsPanel.classList.add('custom-select-options--portal');
    document.body.appendChild(optionsPanel);
    // It's now a body-level child, not a descendant of main — the next
    // render's main.innerHTML wipe won't remove it. Clean it up ourselves
    // when this render's lifetime ends.
    signal.addEventListener('abort', () => optionsPanel.remove());

    function positionPanel() {
      const rect = trigger.getBoundingClientRect();
      optionsPanel.style.left = `${rect.left}px`;
      optionsPanel.style.top = `${rect.bottom + 6}px`;
      optionsPanel.style.width = `${rect.width}px`;
    }

    function onScroll() {
      if (root.classList.contains('open')) close();
    }

    function close() {
      root.classList.remove('open');
      optionsPanel.classList.remove('is-open');
      window.removeEventListener('scroll', onScroll, true);
    }

    // Shared by setValue() (external/initial sync) and the option click
    // handler below (user-driven selection) — previously only setValue()
    // did this, so clicking an option fired onChange() and closed the
    // panel, but the trigger label and .selected state never updated to
    // reflect the click. The setting was actually being applied
    // underneath; it just looked like clicking did nothing.
    function applySelection(value) {
      let match = null;
      options.forEach((o) => {
        const isMatch = o.dataset.value === String(value);
        o.classList.toggle('selected', isMatch);
        if (isMatch) match = o;
      });
      if (label && match) label.textContent = match.textContent;
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !root.classList.contains('open');
      // Close any other open portaled select first — otherwise clicking
      // straight from one trigger to another leaves both panels open,
      // since stopPropagation() here skips the document click-close.
      document.querySelectorAll('.custom-select-options--portal.is-open').forEach((p) => p.classList.remove('is-open'));
      document.querySelectorAll('.custom-select.open').forEach((r) => r.classList.remove('open'));
      if (opening) {
        positionPanel();
        root.classList.add('open');
        optionsPanel.classList.add('is-open');
        window.addEventListener('scroll', onScroll, { capture: true, signal });
      }
    }, { signal });
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        close();
        applySelection(opt.dataset.value);
        onChange(opt.dataset.value);
      }, { signal });
    });
    document.addEventListener('click', close, { signal });
    window.addEventListener('resize', () => { if (root.classList.contains('open')) positionPanel(); }, { signal });

    return {
      setValue: applySelection,
    };
  }

  const eqModeCustomSelect = initCustomSelect(eqModeSelect, (value) => window.MusikEQ?.setMode(value));
  const eqAdvancedCountCustomSelect = initCustomSelect(eqAdvancedCountSelect, (value) => window.MusikEQ?.setBandCount('advanced', Number(value)));

  // Percent-based math against each rail's own rect, not a hardcoded
  // pixel height, so this stays correct if .eq-band-rail's height changes.

  function gainToTopPercent(dB) {
    return (1 - (dB + 12) / 24) * 100; // -12dB -> 100% (bottom), +12dB -> 0% (top)
  }

  // Redraws the connecting curve from live DOM thumb positions — turns
  // separate sliders into one continuous shape. Cheap enough for every
  // drag tick (no re-render, just path-string math).
  function updateEqCurve(consoleEl) {
    const svg = consoleEl.querySelector('.eq-console-curve');
    if (!svg) return;
    const bandEls = Array.from(consoleEl.querySelectorAll('.eq-band'));
    if (bandEls.length < 2) { svg.innerHTML = ''; return; }

    const consoleRect = consoleEl.getBoundingClientRect();

    // Centerline uses a rail's own rect (position never moves mid-drag,
    // only the thumb does) as an exact 0dB reference. Same rect gives us
    // the rail's bottom edge, which is where the fill below should stop
    // — it was previously running the full console height and washing
    // out the dB inputs sitting underneath.
    const centerline = consoleEl.querySelector('.eq-console-centerline');
    const railRect = bandEls[0].querySelector('.eq-band-rail').getBoundingClientRect();
    const railBottomY = railRect.bottom - consoleRect.top;
    if (centerline) {
      const railMidY = railRect.top + railRect.height / 2 - consoleRect.top;
      centerline.style.top = `${railMidY}px`;
    }

    const points = bandEls.map((el) => {
      const thumb = el.querySelector('.eq-band-thumb');
      const r = thumb.getBoundingClientRect();
      return [r.left + r.width / 2 - consoleRect.left, r.top + r.height / 2 - consoleRect.top];
    });

    svg.setAttribute('viewBox', `0 0 ${consoleRect.width} ${consoleRect.height}`);

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const bottom = railBottomY;
    const fillPath = `M${points[0][0].toFixed(1)},${bottom} ` +
      points.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
      ` L${points[points.length - 1][0].toFixed(1)},${bottom} Z`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="eq-fill-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color:var(--color-accent); stop-opacity:0.28" />
          <stop offset="100%" style="stop-color:var(--color-accent); stop-opacity:0" />
        </linearGradient>
      </defs>
      <path class="eq-console-curve-fill" d="${fillPath}" fill="url(#eq-fill-fade)"></path>
      <path class="eq-console-curve-line" d="${linePath}"></path>
    `;
  }

  function attachFaderDrag(bandEl, bandIndex, consoleEl) {
    const rail = bandEl.querySelector('.eq-band-rail');
    const thumb = bandEl.querySelector('.eq-band-thumb');
    const valueEl = bandEl.querySelector('.eq-band-gain-value');

    function applyFromClientY(clientY) {
      const rect = rail.getBoundingClientRect();
      let frac = 1 - (clientY - rect.top) / rect.height; // 1 = top = +12dB, 0 = bottom = -12dB
      frac = Math.max(0, Math.min(1, frac));
      const dB = Math.round((frac * 24 - 12) * 10) / 10; // continuous 0.1dB resolution, no native-slider snapping
      const applied = window.MusikEQ.previewBandGain(bandIndex, dB);
      thumb.style.top = `${gainToTopPercent(applied)}%`;
      valueEl.value = applied;
      updateEqCurve(consoleEl);
      return applied;
    }

    function onPointerMove(e) { applyFromClientY(e.clientY); }

    function onPointerUp(e) {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      thumb.classList.remove('eq-band-thumb--dragging');
      // Commit once at drag end — persists + broadcasts musik:eq-change.
      const finalDb = applyFromClientY(e.clientY);
      window.MusikEQ.commitBandGain(bandIndex, finalDb);
    }

    function onPointerDown(e) {
      e.preventDefault();
      thumb.classList.add('eq-band-thumb--dragging');
      applyFromClientY(e.clientY);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: true });
    }

    thumb.addEventListener('pointerdown', onPointerDown);
    rail.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return; // thumb has its own handler
      onPointerDown(e);
    });
  }

  function renderEqSection() {
    if (!window.MusikEQ) return;
    const state = window.MusikEQ.getState();

    eqModeCustomSelect?.setValue(state.mode);
    eqAdvancedCountCustomSelect?.setValue(String(state.advancedBands));

    eqAdvancedCountRow.style.display = state.mode === 'advanced' ? '' : 'none';
    eqPresetsRow.style.display = state.mode === 'off' ? 'none' : '';
    eqBandsRow.style.display = state.mode === 'off' ? 'none' : '';

    if (state.mode === 'off') return;

    eqPresetsWrap.innerHTML = window.MusikEQ.listPresets().map((p) => `
      <button type="button" class="eq-preset-btn ${state.lastPreset === p.id ? 'eq-preset-btn--active' : ''}" data-preset-id="${p.id}">
        <span class="eq-preset-btn-spark">${p.sparkline}</span>
        <span class="eq-preset-btn-label">${p.label}</span>
      </button>
    `).join('');
    eqPresetsWrap.querySelectorAll('.eq-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => window.MusikEQ.applyPreset(btn.dataset.presetId));
    });

    const indices = window.MusikEQ.getVisibleIndices();
    const labels = window.MusikEQ.getBandLabels();
    const editableFreqQ = state.mode === 'master';

    // One shared glass panel with one centerline + curve overlay, instead
    // of each band being its own isolated box.
    eqBandsWrap.innerHTML = `
      <div class="eq-console" id="eq-console">
        <div class="eq-console-centerline"></div>
        <svg class="eq-console-curve" preserveAspectRatio="none"></svg>
        <div class="eq-console-bands">
          ${indices.map((bandIndex, i) => {
            const band = state.bands[bandIndex];
            return `
              <div class="eq-band" data-band-index="${bandIndex}">
                <span class="eq-band-label">${labels[i]}</span>
                <div class="eq-band-rail">
                  <div class="eq-band-thumb" style="top:${gainToTopPercent(band.gain)}%"></div>
                </div>
                <span class="eq-band-gain-field">
                  <input type="number" class="eq-band-gain-value" min="-12" max="12" step="0.1" value="${band.gain}" aria-label="Gain in decibels" />
                  <span class="eq-band-gain-unit">dB</span>
                </span>
                ${editableFreqQ ? `
                  <label class="eq-band-subfield">Hz <input type="number" class="eq-band-freq" min="20" max="20000" step="1" value="${Math.round(band.freq)}" /></label>
                  <label class="eq-band-subfield">Q <input type="number" class="eq-band-q" min="0.1" max="10" step="0.1" value="${band.q}" /></label>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    const consoleEl = document.getElementById('eq-console');
    const commitOnEnter = (e) => { if (e.key === 'Enter') e.target.blur(); };

    consoleEl.querySelectorAll('.eq-band').forEach((el) => {
      const idx = Number(el.dataset.bandIndex);
      attachFaderDrag(el, idx, consoleEl);
      el.querySelector('.eq-band-gain-value')?.addEventListener('change', (e) => {
        window.MusikEQ.setBandGain(idx, Number(e.target.value));
      });
      el.querySelector('.eq-band-freq')?.addEventListener('change', (e) => {
        window.MusikEQ.setBandFreq(idx, Number(e.target.value));
      });
      el.querySelector('.eq-band-q')?.addEventListener('change', (e) => {
        window.MusikEQ.setBandQ(idx, Number(e.target.value));
      });
      el.querySelectorAll('.eq-band-gain-value, .eq-band-freq, .eq-band-q').forEach((input) => {
        input.addEventListener('keydown', commitOnEnter);
      });
    });
    updateEqCurve(consoleEl);
  }

  // Presets/mode/band-count changes funnel through this event so the UI
  // never drifts from real state. Drag-in-progress updates don't — see
  // previewBandGain in eq.js.
  window.addEventListener('musik:eq-change', renderEqSection, { signal });
  renderEqSection();

  const navGrid = document.getElementById('layout-nav-grid');

  function paintNavActive() {
    const current = getLayoutMode();
    navGrid.querySelectorAll('.layout-card').forEach((card) => {
      card.classList.toggle('layout-card--active', card.dataset.navMode === current);
    });
  }
  paintNavActive();

  navGrid.querySelectorAll('.layout-card').forEach((card) => {
    card.addEventListener('click', () => {
      localStorage.setItem(LAYOUT_MODE_KEY, card.dataset.navMode);
      paintNavActive();
      broadcastLayoutChange();
    });
  });

  if (duckSettings.available) {
    document.getElementById('settings-duck-enabled').addEventListener('change', (e) => {
      window.Musik?.gameDuck?.setEnabled?.(e.target.checked);
    });

    const sensSlider = document.getElementById('settings-duck-sensitivity');
    const sensValue = document.getElementById('settings-duck-sensitivity-value');
    const paintSens = () => { sensValue.textContent = `${sensSlider.value}%`; };
    paintSens();
    sensSlider.addEventListener('input', () => {
      paintSens();
      window.Musik?.gameDuck?.setSensitivity?.(Number(sensSlider.value) / 100);
    });

    const ceilingSlider = document.getElementById('settings-duck-ceiling');
    const ceilingValue = document.getElementById('settings-duck-ceiling-value');
    const paintCeiling = () => { ceilingValue.textContent = `${ceilingSlider.value}%`; };
    paintCeiling();
    ceilingSlider.addEventListener('input', () => {
      paintCeiling();
      window.Musik?.gameDuck?.setDuckCeiling?.(Number(ceilingSlider.value) / 100);
    });

    const maxSlider = document.getElementById('settings-duck-max');
    const maxValue = document.getElementById('settings-duck-max-value');
    const paintMax = () => { maxValue.textContent = `${maxSlider.value}%`; };
    paintMax();
    maxSlider.addEventListener('input', () => {
      paintMax();
      window.Musik?.gameDuck?.setMaxDuck?.(Number(maxSlider.value) / 100);
    });

    // 'duckdebug' — main.js/game-duck.js don't emit this yet; row stays at "—" until they do.
    // window.Musik.events is a custom bus, not a native EventTarget, so it
    // can't take an AbortSignal directly — remove it by hand on teardown.
    const meterLevel = document.getElementById('settings-duck-meter-level');
    const meterMult = document.getElementById('settings-duck-meter-mult');
    const onDuckDebug = ({ level, smoothed }) => {
      if (meterLevel) meterLevel.textContent = `level: ${Math.round(level * 100)}%`;
      if (meterMult) meterMult.textContent = `volume: ${Math.round(smoothed * 100)}%`;
    };
    window.Musik?.events?.on?.('duckdebug', onDuckDebug);
    signal.addEventListener('abort', () => window.Musik?.events?.off?.('duckdebug', onDuckDebug));
  }

  await refreshModsList();
  document.getElementById('settings-mods-rescan').addEventListener('click', refreshModsList);
  document.getElementById('settings-mods-open-folder').addEventListener('click', () => {
    window.Musik?.mods?.openFolder?.();
  });

  await syncLastfmCredsToMain();
  bindLastfmSection(main);
};

async function refreshLastfmSection() {
  const section = document.getElementById('settings-scrobbling');
  if (!section) return;
  const settings = (await window.Musik?.scrobble?.getSettings?.()) ?? { connected: false };
  section.innerHTML = `<h2 class="settings-section-title">Last.fm</h2>${lastfmSectionHTML(settings)}`;
  bindLastfmSection(document);
}

function bindLastfmSection(scope) {
  const connectBtn = scope.querySelector('#settings-lastfm-connect');
  const disconnectBtn = scope.querySelector('#settings-lastfm-disconnect');
  const tokenRow = scope.querySelector('#settings-lastfm-token-row');
  const tokenSubmit = scope.querySelector('#settings-lastfm-token-submit');
  const errorEl = scope.querySelector('#settings-lastfm-error');

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  connectBtn?.addEventListener('click', async () => {
    connectBtn.disabled = true;
    try {
      const url = await window.Musik?.scrobble?.getAuthUrl?.();
      if (!url) return;
      window.Musik?.system?.openExternal?.(url);
      tokenRow.hidden = false;
    } finally {
      connectBtn.disabled = false;
    }
  });

  tokenSubmit?.addEventListener('click', async () => {
    tokenSubmit.disabled = true;
    tokenSubmit.textContent = 'Connecting…';
    try {
      await window.Musik?.scrobble?.completeAuth?.();
      await refreshLastfmSection();
    } catch (err) {
      showError(err?.message || 'Couldn\'t connect — make sure you approved access, then try again.');
      tokenSubmit.disabled = false;
      tokenSubmit.textContent = "I've approved it";
    }
  });

  disconnectBtn?.addEventListener('click', async () => {
    disconnectBtn.disabled = true;
    await window.Musik?.scrobble?.disconnect?.();
    await refreshLastfmSection();
  });

  const apiKeyInput = scope.querySelector('#settings-lastfm-apikey-input');
  const apiSecretInput = scope.querySelector('#settings-lastfm-apisecret-input');
  const credsSaveBtn = scope.querySelector('#settings-lastfm-creds-save');
  const credsClearBtn = scope.querySelector('#settings-lastfm-creds-clear');
  const credsStatus = scope.querySelector('#settings-lastfm-creds-status');

  function showCredsStatus(msg) {
    if (!credsStatus) return;
    credsStatus.textContent = msg;
    credsStatus.hidden = false;
  }

  credsSaveBtn?.addEventListener('click', async () => {
    const apiKey = apiKeyInput?.value.trim() || '';
    const apiSecret = apiSecretInput?.value.trim() || '';
    setStoredLastfmCreds(apiKey, apiSecret);
    credsSaveBtn.disabled = true;
    credsSaveBtn.textContent = 'Saving…';
    try {
      await window.Musik?.scrobble?.setCredentials?.({ apiKey: apiKey || '', apiSecret: apiSecret || '' });
      showCredsStatus('Saved to this browser only.');
    } finally {
      credsSaveBtn.disabled = false;
      credsSaveBtn.textContent = 'Save';
      await refreshLastfmSection();
    }
  });

  credsClearBtn?.addEventListener('click', async () => {
    setStoredLastfmCreds('', '');
    await window.Musik?.scrobble?.setCredentials?.({ apiKey: '', apiSecret: '' });
    await refreshLastfmSection();
  });
}
