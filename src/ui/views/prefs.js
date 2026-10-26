// src/ui/views/prefs.js
// Pref keys, getters, helpers and the page markup for settings.js. Load before it.

window.MusikViews = window.MusikViews || {};

// Shared with app.js. Broadcast via 'musik:layout-change' so an
// already-open app.js instance updates live instead of needing a reload.
const LAYOUT_MODE_KEY = 'musikLayoutMode';

function getLayoutMode() {
  return localStorage.getItem(LAYOUT_MODE_KEY) || 'dynamic';
}

const COMPACT_SETTINGS_KEY = 'musik:compact-settings';

function getCompactSettings() {
  return localStorage.getItem(COMPACT_SETTINGS_KEY) !== 'off';
}
function broadcastLayoutChange() {
  window.dispatchEvent(new CustomEvent('musik:layout-change', {
    detail: { mode: getLayoutMode() },
  }));
}

// 3D visualizer quality: visualizer.js applies it live (MusikVisualizer.setQuality);
// this persists the pref and broadcasts so an open Fullscreen view updates.
const VIS_QUALITY_KEY = 'musik:visualizer-quality';

function getVisQuality() {
  return localStorage.getItem(VIS_QUALITY_KEY) || 'medium';
}
function broadcastVisualizerChange(detail) {
  window.dispatchEvent(new CustomEvent('musik:visualizer-settings-change', { detail }));
}

// 3D blob reactivity. visualizer.js reads this straight out of localStorage
// every frame (draw3d), so writing it here is enough - no broadcast event
// needed for it to take effect live.
const VIS_SENSITIVITY_KEY = 'musik_vis_sensitivity';

function getVisSensitivityPercent() {
  const raw = parseFloat(localStorage.getItem(VIS_SENSITIVITY_KEY));
  return Number.isFinite(raw) ? Math.round(raw * 100) : 100;
}

// "Custom effects": rim glow + dither, both uniform-gated in visualizer.js so
// toggling applies live. The master gates both subs.
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

// Default volume is applied at next launch, before the player-bar slider is touched.
// Nothing outside this file reads this key yet; boot needs to read it in player-ui.js.
const DEFAULT_VOLUME_KEY = 'musikDefaultVolume';

function getStoredDefaultVolumePercent() {
  const raw = parseFloat(localStorage.getItem(DEFAULT_VOLUME_KEY));
  if (Number.isFinite(raw)) return Math.round(raw * 100);
  // No saved default yet - fall back to whatever's currently playing so the
  // slider doesn't jump to some arbitrary unrelated number on first render.
  return Math.round((window.MusikPlayerUI?.getVolume?.() ?? 1) * 100);
}

const MINI_ALWAYS_ON_TOP_KEY = 'musikMiniAlwaysOnTop';

function getMiniAlwaysOnTop() {
  return localStorage.getItem(MINI_ALWAYS_ON_TOP_KEY) !== 'false';
}

// Own Last.fm API key/secret. localStorage only - never written to a repo
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

// Exposed so app.js can push the saved key into the scrobbler on boot; before,
// it only ran when Settings rendered, so early scrobbles failed with "API key missing".
window.MusikViews.syncLastfmCredsToMain = syncLastfmCredsToMain;

function layoutNavItemHTML(mode, active, inline) {
  const label = mode === 'pinned' ? '<span class="layout-mock-line"></span>' : '';
  const classes = [
    'layout-mock-navitem',
    active ? 'layout-mock-navitem--active' : '',
    inline ? 'layout-mock-navitem--inline' : '',
  ].filter(Boolean).join(' ');
  return `<span class="${classes}"><span class="layout-mock-dot"></span>${label}</span>`;
}

function layoutCardHTML(mode, title, desc) {
  if (mode === 'topbar') {
    return `
      <button type="button" class="layout-card" data-nav-mode="${mode}">
        <div class="layout-mock layout-mock--topbar">
          <div class="layout-mock-bar">
            ${layoutNavItemHTML(mode, true, true)}
            ${layoutNavItemHTML(mode, false, true)}
            ${layoutNavItemHTML(mode, false, true)}
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
          ${layoutNavItemHTML(mode, true, false)}
          ${layoutNavItemHTML(mode, false, false)}
          ${layoutNavItemHTML(mode, false, false)}
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

// Shared by every range slider + live label row; also paints the accent fill (--fill).
// formatFn defaults to a percentage.
function bindRangeValueDisplay(slider, valueEl, onInput, formatFn) {
  const format = formatFn || ((v) => `${v}%`);
  const paint = () => {
    valueEl.textContent = format(slider.value);
    const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100;
    slider.style.setProperty('--fill', `${pct}%`);
  };
  paint();
  slider.addEventListener('input', () => {
    paint();
    onInput?.(slider.value);
  });
  return paint;
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
        <span class="settings-row-desc">Stays in local storage, never written to disk. Leave blank to use the shared key.</span>
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
        <span class="settings-row-desc">${hasKey ? 'Connect Last.fm to scrobble your plays.' : 'Add your API key below first, then connect.'}</span>
      </div>
      <div class="settings-row-control">
        <button id="settings-lastfm-connect" class="btn" ${hasKey ? '' : 'disabled'}>Connect</button>
      </div>
    </div>
    <div class="settings-row settings-row--stack" id="settings-lastfm-token-row" hidden>
      <div class="settings-row-label">
        <span class="settings-row-name">Approved in your browser?</span>
        <span class="settings-row-desc">Approve Musik on the Last.fm page, then confirm here.</span>
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
        <span class="settings-row-desc">v${mod.version} by ${mod.author}</span>
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
      showError(err?.message || 'Couldn\'t connect. Make sure you approved access, then try again.');
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

// Settings page markup.
function settingsHTML(duckSettings, scrobblerSettings, duckAdvancedOpen) {
  return `
    <div class="settings-page${getCompactSettings() ? ' settings-page--compact' : ''}">
      <div class="settings-header">
        <h1 class="settings-title">Settings</h1>
        <div class="settings-view-toggle" id="settings-view-toggle" role="group" aria-label="Settings layout" data-compact="${getCompactSettings()}">
          <span class="settings-view-toggle-thumb" aria-hidden="true"></span>
          <button type="button" class="settings-view-opt" data-compact="false" aria-pressed="${!getCompactSettings()}" aria-label="Single column" title="Single column">
            <svg class="settings-view-icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect class="sv-bar sv-bar--single" x="2" y="3" width="12" height="10" rx="2.5"/>
            </svg>
          </button>
          <button type="button" class="settings-view-opt" data-compact="true" aria-pressed="${getCompactSettings()}" aria-label="Side by side" title="Side by side">
            <svg class="settings-view-icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect class="sv-bar sv-bar--l" x="2" y="3" width="5" height="10" rx="2"/>
              <rect class="sv-bar sv-bar--r" x="9" y="3" width="5" height="10" rx="2"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="settings-section-grid settings-section-grid--compact">
        <section class="settings-section" id="settings-playback">
          <h2 class="settings-section-title">Playback</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Default volume</span>
            </div>
            <div class="settings-row-control">
              <input type="range" id="settings-default-volume" min="0" max="100"
                value="${getStoredDefaultVolumePercent()}" />
              <span id="settings-default-volume-value" class="settings-row-value"></span>
            </div>
          </div>
        </section>

        <section class="settings-section" id="settings-miniplayer">
          <h2 class="settings-section-title">Miniplayer</h2>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Always on top</span>
              <span class="settings-row-desc">Keep the miniplayer above other windows.</span>
            </div>
            <div class="settings-row-control">
              <input type="checkbox" id="settings-mini-always-on-top" ${getMiniAlwaysOnTop() ? 'checked' : ''} />
            </div>
          </div>
        </section>
      </div>

      <section class="settings-section" id="settings-layout">
        <h2 class="settings-section-title">Layout</h2>
        <div class="settings-row settings-row--stack">
          <div class="settings-row-label">
            <span class="settings-row-name">Navigation</span>
          </div>
        </div>
        <div class="layout-grid" id="layout-nav-grid">
          ${layoutCardHTML('dynamic', 'Dynamic', 'Hidden until you hover the edge.')}
          ${layoutCardHTML('pinned', 'Pinned', 'Sidebar stays expanded, always visible.')}
          ${layoutCardHTML('topbar', 'Top Bar', 'Sidebar becomes a bar across the top.')}
        </div>
      </section>

      <section class="settings-section" id="settings-eq">
        <h2 class="settings-section-title">Equalizer</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Mode</span>
            <span class="settings-row-desc">Off bypasses the EQ. Master also lets you tune each band's frequency and width.</span>
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
            <span class="settings-row-desc">Lower it on weaker hardware.</span>
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
            <span class="settings-row-desc">How strongly the visual reacts to the music.</span>
          </div>
          <div class="settings-row-control">
            <input type="range" id="settings-vis-sensitivity" min="25" max="200"
              value="${getVisSensitivityPercent()}" />
            <span id="settings-vis-sensitivity-value" class="settings-row-value"></span>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Custom effects</span>
            <span class="settings-row-desc">Extra effects. Off by default.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-vis-customfx" ${getCustomFxOn() ? 'checked' : ''} />
          </div>
        </div>
        <div class="settings-row settings-row--sub" id="settings-vis-fresnel-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Rim glow</span>
            <span class="settings-row-desc">Glowing edge on the shape.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-vis-fresnel" ${getFresnelOn() ? 'checked' : ''} ${getCustomFxOn() ? '' : 'disabled'} />
          </div>
        </div>
        <div class="settings-row settings-row--sub" id="settings-vis-dither-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Dither</span>
            <span class="settings-row-desc">Smooths banding in the glow.</span>
          </div>
          <div class="settings-row-control">
            <input type="checkbox" id="settings-vis-dither" ${getDitherOn() ? 'checked' : ''} ${getCustomFxOn() ? '' : 'disabled'} />
          </div>
        </div>
      </section>

      <div class="settings-section-grid settings-section-grid--compact">
      <section class="settings-section" id="settings-library">
        <h2 class="settings-section-title">Library</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Auto-rescan</span>
            <span class="settings-row-desc">Rescan watched folders on launch and on a timer.</span>
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
          </div>
          <div class="settings-row-control">
            <button type="button" id="settings-rescan-now" class="btn">Rescan library</button>
            <span id="settings-rescan-status" class="settings-row-value"></span>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Reset library</span>
            <span class="settings-row-desc">Clears tracks, playlists and watched folders. Your files stay put.</span>
          </div>
          <div class="settings-row-control">
            <button type="button" id="settings-library-reset" class="btn btn--danger">Reset library</button>
            <span id="settings-library-reset-status" class="settings-row-value"></span>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Search history</span>
            <span class="settings-row-desc">Search ranks what you pick higher next time. Stays on this device.</span>
          </div>
          <div class="settings-row-control">
            <button type="button" id="settings-search-history-clear" class="btn">Clear</button>
            <span id="settings-search-history-status" class="settings-row-value"></span>
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
      </div>

      <section class="settings-section" id="settings-shortcuts">
        <h2 class="settings-section-title">Shortcuts</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">Open search</span>
            <span class="settings-row-desc" id="settings-search-shortcut-desc">Works from anywhere in Musik. Click, then press the keys you want.</span>
          </div>
          <div class="settings-row-control">
            <button type="button" id="settings-search-shortcut" class="btn"></button>
            <button type="button" id="settings-search-shortcut-reset" class="btn">Reset</button>
          </div>
        </div>
      </section>

      <section class="settings-section" id="settings-game-mode">
        <h2 class="settings-section-title">Game mode</h2>
        ${!duckSettings.available ? `
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Reactive volume ducking</span>
              <span class="settings-row-desc">Windows only.</span>
            </div>
          </div>
        ` : `
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Reactive volume ducking</span>
              <span class="settings-row-desc">Lowers Musik when games or other apps get loud. Ctrl+Shift+D overrides it.</span>
            </div>
            <div class="settings-row-control">
              <input type="checkbox" id="settings-duck-enabled" ${duckSettings.enabled ? 'checked' : ''} />
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Preset</span>
              <span class="settings-row-desc" id="settings-duck-preset-desc"></span>
            </div>
            <div class="settings-row-control">
              <div class="segmented" id="settings-duck-presets">
                <button type="button" class="segmented-btn" data-duck-preset="gaming">Gaming</button>
                <button type="button" class="segmented-btn" data-duck-preset="meetings">Meetings</button>
                <button type="button" class="segmented-btn" data-duck-preset="movies">Movies</button>
                <button type="button" class="segmented-btn" data-duck-preset="custom">Custom</button>
              </div>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Advanced</span>
              <span class="settings-row-desc">Manual sliders. Moving one switches to Custom.</span>
            </div>
            <div class="settings-row-control">
              <button type="button" class="btn" id="settings-duck-advanced-toggle" aria-pressed="${duckAdvancedOpen}">${duckAdvancedOpen ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div class="settings-row settings-duck-adv" ${duckAdvancedOpen ? '' : 'style="display:none"'}>
            <div class="settings-row-label">
              <span class="settings-row-name">Sensitivity</span>
              <span class="settings-row-desc">Higher ducks on quieter sounds.</span>
            </div>
            <div class="settings-row-control">
              <input type="range" id="settings-duck-sensitivity" min="0" max="100"
                value="${Math.round(duckSettings.sensitivity * 100)}" />
              <span id="settings-duck-sensitivity-value" class="settings-row-value"></span>
            </div>
          </div>
          <div class="settings-row settings-duck-adv" ${duckAdvancedOpen ? '' : 'style="display:none"'}>
            <div class="settings-row-label">
              <span class="settings-row-name">Duck ceiling</span>
              <span class="settings-row-desc">How loud counts as "fully loud". Lower it if ducking feels weak.</span>
            </div>
            <div class="settings-row-control">
              <input type="range" id="settings-duck-ceiling" min="1" max="100"
                value="${Math.round(duckSettings.duckCeiling * 100)}" />
              <span id="settings-duck-ceiling-value" class="settings-row-value"></span>
            </div>
          </div>
          <div class="settings-row settings-duck-adv" ${duckAdvancedOpen ? '' : 'style="display:none"'}>
            <div class="settings-row-label">
              <span class="settings-row-name">Max duck amount</span>
              <span class="settings-row-desc">How far Musik drops at full loudness.</span>
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
              <span class="settings-row-desc">Play something loud in another app to test.</span>
            </div>
            <div class="settings-row-control settings-row-control--inline">
              <span id="settings-duck-meter-level" class="settings-row-value">level: -</span>
              <span id="settings-duck-meter-mult" class="settings-row-value">volume: -</span>
            </div>
          </div>
        `}
      </section>

      <div class="settings-section-grid settings-section-grid--compact">
      <section class="settings-section" id="settings-scrobbling">
        <h2 class="settings-section-title">Last.fm</h2>
        ${lastfmSectionHTML(scrobblerSettings)}
      </section>

      <section class="settings-section" id="settings-debug">
        <h2 class="settings-section-title">Debug</h2>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-name">System check</span>
            <span class="settings-row-desc">Bridge status and a playback test.</span>
          </div>
          <div class="settings-row-control">
            <button id="settings-open-system-check" class="btn">Open</button>
          </div>
        </div>
      </section>
      </div>

      <nav class="settings-section-rail" aria-label="Settings sections">
        <button type="button" class="settings-section-dot is-active" data-target="settings-playback" aria-label="Playback"><span>Playback</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-miniplayer" aria-label="Miniplayer"><span>Miniplayer</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-layout" aria-label="Layout"><span>Layout</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-eq" aria-label="Equalizer"><span>Equalizer</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-visualizer" aria-label="Visualizer"><span>Visualizer</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-library" aria-label="Library"><span>Library</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-mods" aria-label="Mods"><span>Mods</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-shortcuts" aria-label="Shortcuts"><span>Shortcuts</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-game-mode" aria-label="Game mode"><span>Game mode</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-scrobbling" aria-label="Last.fm"><span>Last.fm</span></button>
        <button type="button" class="settings-section-dot" data-target="settings-debug" aria-label="Debug"><span>Debug</span></button>
      </nav>
      <button type="button" class="settings-back-to-top" aria-label="Back to top">↑</button>
    </div>
  `;
}
