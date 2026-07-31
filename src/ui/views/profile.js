// src/ui/views/profile.js
//
// #/profile — profile header (avatar + username, local-only, no IPC),
// session stats (always local, resets on relaunch), lifetime stats (local
// stats.js OR Last.fm's all-time totals — user now picks explicitly via a
// toggle instead of Musik silently preferring Last.fm), and optional
// library stats (computed client-side from library.getTracks()).
//
// PROFILE HEADER STORAGE, flagged explicitly:
// Avatar + username are stored in localStorage (musik.profile.avatar /
// musik.profile.username), NOT persisted through musik-library.json or any
// IPC channel — there's no profile-settings surface in the main process
// yet. This is deliberately the simplest thing that works for a
// single-machine local profile; if you want this synced/backed up or
// available to main-process code later, it needs an actual IPC channel +
// storage.js field, flagging that as a real follow-up rather than doing it
// silently. Avatar is capped client-side at ~1.5MB source file size before
// reading, to keep localStorage (5-10MB browser-enforced quota) from
// filling up on one image.
//
// LIFETIME STATS SOURCE:
// Total LISTENING TIME (minutes) always comes from the local tally
// regardless of source picked, since Last.fm's API only exposes play
// counts, never duration.

window.MusikViews = window.MusikViews || {};

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// Splits a raw artist tag on common multi-artist separators — same
// pattern as search.js's splitArtists, kept independent here since this
// file doesn't load search.js and the logic is a few lines either way.
const ARTIST_SPLIT_RE = /\s*[,;/&]\s*|\s+(?:feat\.?|ft\.?|x)\s+/gi;
function splitArtists(raw) {
  if (!raw) return [];
  return raw.split(ARTIST_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

// Merges topArtists entries that are really the same person credited
// differently across tracks — "A;B" and "A;C" both get folded into "A"
// (the primary/first-listed artist), instead of showing as two separate
// rows that split what should be one person's play count. Grouped by a
// normalized key: lowercased, punctuation stripped, first two words of
// the primary artist only — catches "DJ Snake" vs "dj  snake" too, not
// just the collab-splitting case.
function normalizeArtistKey(name) {
  const primary = splitArtists(name)[0] || name || '';
  return primary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

function dedupeTopArtists(topArtists) {
  if (!topArtists || !topArtists.length) return topArtists;

  const merged = new Map(); // normalized key -> { key: displayName, count }
  for (const entry of topArtists) {
    // entry.key may be "artist" or "artist::something" (see topListHTML's
    // handling below) — only the artist portion matters for grouping.
    const rawName = entry.key.includes('::') ? entry.key.split('::')[0] : entry.key;
    const primary = splitArtists(rawName)[0] || rawName;
    const normKey = normalizeArtistKey(rawName);
    if (!normKey) continue;

    const existing = merged.get(normKey);
    if (existing) {
      existing.count += entry.count;
      // Prefer the shorter display name as canonical (less likely to be
      // "Artist feat. Someone" style noise leaking into the primary slot).
      if (primary.length < existing.key.length) existing.key = primary;
    } else {
      merged.set(normKey, { key: primary, count: entry.count });
    }
  }

  return [...merged.values()].sort((a, b) => b.count - a.count);
}

function topListHTML(items, emptyLabel) {
  if (!items || !items.length) {
    return `<div class="profile-top-empty">${escapeHTML(emptyLabel)}</div>`;
  }
  return `
    <ol class="profile-top-list">
      ${items.slice(0, 5).map((item) => {
        const label = item.key.includes('::') ? item.key.split('::').slice(1).join('::') || item.key : item.key;
        return `
          <li class="profile-top-row">
            <span class="profile-top-name">${escapeHTML(label)}</span>
            <span class="profile-top-count">${item.count}</span>
          </li>
        `;
      }).join('')}
    </ol>
  `;
}

function libraryStatsHTML(tracks) {
  if (!tracks.length) {
    return `<div class="profile-lib-empty">No tracks in your library yet.</div>`;
  }

  const artists = new Set();
  const albums = new Set();
  const formats = {};
  let totalSeconds = 0;

  for (const t of tracks) {
    if (t.artist) artists.add(t.artist);
    if (t.album) albums.add(`${t.artist || ''}::${t.album}`);
    totalSeconds += t.duration || 0;
    const ext = (t.filePath.split('.').pop() || '?').toUpperCase();
    formats[ext] = (formats[ext] || 0) + 1;
  }

  const formatEntries = Object.entries(formats).sort((a, b) => b[1] - a[1]);

  return `
    <div class="profile-lib-grid">
      <div class="profile-lib-stat"><span class="profile-lib-num">${tracks.length}</span><span class="profile-lib-label">Tracks</span></div>
      <div class="profile-lib-stat"><span class="profile-lib-num">${artists.size}</span><span class="profile-lib-label">Artists</span></div>
      <div class="profile-lib-stat"><span class="profile-lib-num">${albums.size}</span><span class="profile-lib-label">Albums</span></div>
      <div class="profile-lib-stat"><span class="profile-lib-num">${fmtDuration(totalSeconds)}</span><span class="profile-lib-label">Total length</span></div>
    </div>
    <div class="profile-lib-formats">
      ${formatEntries.map(([ext, count]) => `<span class="profile-lib-format-pill">${escapeHTML(ext)} · ${count}</span>`).join('')}
    </div>
  `;
}

// ── Profile header (avatar + username) ──────────────────────────────
// localStorage-backed, see file header note. Kept as its own render pass
// so switching the stats-source toggle never touches/reloads it.

const AVATAR_KEY = 'musik.profile.avatar';
const USERNAME_KEY = 'musik.profile.username';
const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024; // source file cap — generous, since we re-encode a small crop anyway
const CROP_VIEWPORT = 260; // on-screen crop circle size, px
const CROP_OUTPUT = 320;   // saved image resolution, px (square, displayed via circular clip in CSS)

function getSavedAvatar() {
  try { return localStorage.getItem(AVATAR_KEY) || null; } catch { return null; }
}
function getSavedUsername() {
  try { return localStorage.getItem(USERNAME_KEY) || ''; } catch { return ''; }
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// Drag-to-pan, wheel/slider-to-zoom crop modal. Appended to document.body
// (same reasoning as search.js's overlay — survives view swaps, always on
// top). Resolves with a square dataURL crop, or null if cancelled.
function openAvatarCropper(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    const backdrop = document.createElement('div');
    backdrop.className = 'avatar-crop-backdrop';
    backdrop.innerHTML = `
      <div class="avatar-crop-panel glass-surface glass-surface--elevated">
        <div class="avatar-crop-title">Position your photo</div>
        <div class="avatar-crop-viewport" id="avatar-crop-viewport" style="width:${CROP_VIEWPORT}px;height:${CROP_VIEWPORT}px;">
          <img class="avatar-crop-img" id="avatar-crop-img" src="${objectUrl}" draggable="false" alt="">
        </div>
        <div class="avatar-crop-hint">Drag to reposition · scroll or use the slider to zoom</div>
        <input type="range" id="avatar-crop-zoom" class="avatar-crop-zoom" min="100" max="300" value="100">
        <div class="avatar-crop-actions">
          <button type="button" class="avatar-crop-btn avatar-crop-btn--cancel" id="avatar-crop-cancel">Cancel</button>
          <button type="button" class="avatar-crop-btn avatar-crop-btn--save" id="avatar-crop-save">Save photo</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('avatar-crop-backdrop--visible'));

    const cropImg = backdrop.querySelector('#avatar-crop-img');
    const viewport = backdrop.querySelector('#avatar-crop-viewport');
    const zoomSlider = backdrop.querySelector('#avatar-crop-zoom');
    const cancelBtn = backdrop.querySelector('#avatar-crop-cancel');
    const saveBtn = backdrop.querySelector('#avatar-crop-save');

    let coverScale = 1;
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let maxOffsetX = 0;
    let maxOffsetY = 0;

    function clampAndApply() {
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      maxOffsetX = Math.max(0, (dw - CROP_VIEWPORT) / 2);
      maxOffsetY = Math.max(0, (dh - CROP_VIEWPORT) / 2);
      offsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, offsetX));
      offsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, offsetY));
      cropImg.style.width = `${dw}px`;
      cropImg.style.height = `${dh}px`;
      cropImg.style.transform = `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px)`;
    }

    img.onload = () => {
      coverScale = Math.max(CROP_VIEWPORT / img.naturalWidth, CROP_VIEWPORT / img.naturalHeight);
      scale = coverScale;
      offsetX = 0;
      offsetY = 0;
      clampAndApply();
    };
    img.src = objectUrl;

    // Drag to pan
    let dragging = false;
    let dragStartX = 0, dragStartY = 0, startOffsetX = 0, startOffsetY = 0;
    viewport.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      startOffsetX = offsetX;
      startOffsetY = offsetY;
      viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      offsetX = startOffsetX + (e.clientX - dragStartX);
      offsetY = startOffsetY + (e.clientY - dragStartY);
      clampAndApply();
    });
    viewport.addEventListener('pointerup', () => { dragging = false; });
    viewport.addEventListener('pointercancel', () => { dragging = false; });

    // Wheel to zoom, keeping the slider in sync
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pct = Number(zoomSlider.value) - e.deltaY * 0.15;
      zoomSlider.value = Math.min(300, Math.max(100, pct));
      scale = coverScale * (Number(zoomSlider.value) / 100);
      clampAndApply();
    }, { passive: false });

    zoomSlider.addEventListener('input', () => {
      scale = coverScale * (Number(zoomSlider.value) / 100);
      clampAndApply();
    });

    function cleanup() {
      backdrop.classList.remove('avatar-crop-backdrop--visible');
      setTimeout(() => {
        backdrop.remove();
        URL.revokeObjectURL(objectUrl);
      }, 180);
    }

    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { cleanup(); resolve(null); }
    });

    saveBtn.addEventListener('click', () => {
      // Map the on-screen crop viewport (CROP_VIEWPORT px) to the saved
      // output resolution (CROP_OUTPUT px) — same math as clampAndApply,
      // just scaled up by k for a sharper saved image than the preview.
      const k = CROP_OUTPUT / CROP_VIEWPORT;
      const dw = img.naturalWidth * scale * k;
      const dh = img.naturalHeight * scale * k;
      const destX = (CROP_OUTPUT - dw) / 2 + offsetX * k;
      const destY = (CROP_OUTPUT - dh) / 2 + offsetY * k;

      const canvas = document.createElement('canvas');
      canvas.width = CROP_OUTPUT;
      canvas.height = CROP_OUTPUT;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, destX, destY, dw, dh);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      cleanup();
      resolve(dataUrl);
    });
  });
}

function renderProfileHeader(container) {
  const savedAvatar = getSavedAvatar();
  const savedName = getSavedUsername();

  container.innerHTML = `
    <div class="profile-header-card">
      <div class="profile-avatar-wrap" id="profile-avatar-wrap" title="Click to change photo">
        ${savedAvatar
          ? `<img class="profile-avatar-img" id="profile-avatar-img" src="${savedAvatar}" alt="">`
          : `<div class="profile-avatar-fallback" id="profile-avatar-fallback">${escapeHTML(initials(savedName) || '')}</div>`}
        <div class="profile-avatar-overlay">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </div>
        <input type="file" id="profile-avatar-input" accept="image/*" hidden>
      </div>
      <div class="profile-identity">
        <input
          type="text"
          id="profile-username-input"
          class="profile-username-input"
          placeholder="Add a name"
          maxlength="40"
          value="${escapeHTML(savedName)}"
        >
        <div class="profile-identity-sub">Musik profile · stored on this device</div>
      </div>
    </div>
  `;

  const avatarWrap = document.getElementById('profile-avatar-wrap');
  const avatarInput = document.getElementById('profile-avatar-input');
  const usernameInput = document.getElementById('profile-username-input');

  avatarWrap?.addEventListener('click', () => avatarInput?.click());

  avatarInput?.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    avatarInput.value = ''; // allow re-selecting the same file next time
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > MAX_AVATAR_SOURCE_BYTES) {
      alert('That image is a bit large — try one under 8MB.');
      return;
    }

    const cropped = await openAvatarCropper(file);
    if (!cropped) return; // user cancelled

    try {
      localStorage.setItem(AVATAR_KEY, cropped);
    } catch (err) {
      console.warn('[Musik] profile: failed to save avatar to localStorage:', err.message);
      alert("Couldn't save that image — try a smaller crop or a different photo.");
      return;
    }
    renderProfileHeader(container); // re-render just the header
  });

  let usernameDebounce = null;
  usernameInput?.addEventListener('input', () => {
    clearTimeout(usernameDebounce);
    usernameDebounce = setTimeout(() => {
      try { localStorage.setItem(USERNAME_KEY, usernameInput.value.trim()); } catch {}
      // Fallback avatar shows initials from the name — refresh it live if
      // there's no photo set.
      const fallback = document.getElementById('profile-avatar-fallback');
      if (fallback) fallback.textContent = initials(usernameInput.value);
    }, 300);
  });
}

// ── Stats section (session / lifetime / top / library) ──────────────
// Rendered separately from the header so toggling Local <-> Last.fm only
// re-renders this part.

function renderStatsSection(container, { source, session, localLifetime, lastfmLifetime, connected, tracks }) {
  const usingLastfm = source === 'lastfm' && !!lastfmLifetime;
  const lifetime = usingLastfm ? lastfmLifetime : localLifetime;

  const preConnectFootnote = (() => {
    if (!usingLastfm || !localLifetime?.lastfmConnectedAt || !localLifetime?.firstTrackedAt) return '';
    if (localLifetime.firstTrackedAt >= localLifetime.lastfmConnectedAt) return '';
    return `
      <div class="profile-footnote">
        Musik also tracked ${localLifetime.totalPlays} play${localLifetime.totalPlays === 1 ? '' : 's'} locally
        starting ${escapeHTML(fmtDate(localLifetime.firstTrackedAt))}, before you connected Last.fm on
        ${escapeHTML(fmtDate(localLifetime.lastfmConnectedAt))}.
      </div>
    `;
  })();

  const toggleHTML = connected ? `
    <div class="profile-source-toggle" id="profile-source-toggle" role="tablist">
      <button type="button" class="profile-source-btn ${source === 'local' ? 'is-active' : ''}" data-source="local">Local</button>
      <button type="button" class="profile-source-btn ${source === 'lastfm' ? 'is-active' : ''}" data-source="lastfm">Last.fm</button>
    </div>
  ` : '';

  container.innerHTML = `
    <div class="profile-lifetime-header">
      <div class="profile-card-label" style="margin-bottom:0;">Stats source</div>
      ${toggleHTML || `<span class="profile-source-tag">local</span>`}
    </div>

    <div class="profile-grid">
      <div class="profile-card">
        <div class="profile-card-label">This Session</div>
        <div class="profile-card-main">
          <div class="profile-stat"><span class="profile-stat-num">${session?.plays ?? 0}</span><span class="profile-stat-label">Plays</span></div>
          <div class="profile-stat"><span class="profile-stat-num">${fmtDuration(session?.seconds)}</span><span class="profile-stat-label">Listened</span></div>
        </div>
      </div>

      <div class="profile-card">
        <div class="profile-card-label">
          Lifetime
          <span class="profile-source-tag">${usingLastfm ? 'via Last.fm' : 'local'}</span>
        </div>
        <div class="profile-card-main">
          <div class="profile-stat"><span class="profile-stat-num">${lifetime?.totalPlays ?? 0}</span><span class="profile-stat-label">Plays</span></div>
          <div class="profile-stat"><span class="profile-stat-num">${fmtDuration(localLifetime?.totalSeconds)}</span><span class="profile-stat-label">Listened</span></div>
        </div>
        ${preConnectFootnote}
      </div>
    </div>

    <div class="profile-top-grid">
      <div class="profile-card">
        <div class="profile-card-label">Top Artists</div>
        ${topListHTML(dedupeTopArtists(lifetime?.topArtists), 'Play something to see your top artists.')}
      </div>
      <div class="profile-card">
        <div class="profile-card-label">Top Albums</div>
        ${topListHTML(lifetime?.topAlbums, 'Play something to see your top albums.')}
      </div>
      <div class="profile-card">
        <div class="profile-card-label">Top Tracks</div>
        ${topListHTML(lifetime?.topTracks, 'Play something to see your top tracks.')}
      </div>
    </div>

    <div class="profile-card profile-lib-card">
      <button class="profile-card-label profile-lib-toggle" id="profile-lib-toggle">
        Library Stats
        <svg class="profile-lib-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="profile-lib-content" id="profile-lib-content">
        ${libraryStatsHTML(tracks)}
      </div>
    </div>
  `;

  document.getElementById('profile-source-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.profile-source-btn');
    if (!btn) return;
    const newSource = btn.dataset.source;
    if (newSource === source) return;
    try { localStorage.setItem('musik.profile.statsSource', newSource); } catch {}
    renderStatsSection(container, { source: newSource, session, localLifetime, lastfmLifetime, connected, tracks });
  });

  const libToggle = document.getElementById('profile-lib-toggle');
  const libContent = document.getElementById('profile-lib-content');
  libToggle?.addEventListener('click', () => {
    libToggle.classList.toggle('is-open');
    libContent?.classList.toggle('is-open');
  });
}

window.MusikViews.profile = async function renderProfile(main) {
  main.innerHTML = `
    <div class="home-wrap profile-wrap">
      <div class="home-topbar">
        <h1 class="view-title">Profile</h1>
      </div>
      <div id="profile-header"></div>
      <div id="profile-body" class="profile-loading">Loading stats...</div>
    </div>
  `;

  renderProfileHeader(document.getElementById('profile-header'));

  const [session, localLifetime, scrobbleSettings, tracks] = await Promise.all([
    window.Musik?.stats?.getSession?.() ?? null,
    window.Musik?.stats?.getLifetime?.() ?? null,
    window.Musik?.scrobble?.getSettings?.() ?? null,
    window.Musik?.library?.getTracks?.() ?? [],
  ]);

  const connected = !!scrobbleSettings?.connected;
  const lastfmLifetime = connected ? await window.Musik?.scrobble?.getLifetimeStats?.() : null;

  // Default source: user's last explicit choice if still valid (e.g. they
  // picked Last.fm before, still connected), otherwise Last.fm once
  // connected (richer, cross-device), otherwise local. Never silently
  // override an explicit choice the way the old auto-preference did.
  let savedSource = null;
  try { savedSource = localStorage.getItem('musik.profile.statsSource'); } catch {}
  const initialSource = (savedSource === 'local' || savedSource === 'lastfm') && (savedSource !== 'lastfm' || connected)
    ? savedSource
    : (connected && lastfmLifetime ? 'lastfm' : 'local');

  const body = document.getElementById('profile-body');
  body.className = '';
  renderStatsSection(body, {
    source: initialSource,
    session,
    localLifetime,
    lastfmLifetime,
    connected: connected && !!lastfmLifetime,
    tracks,
  });
};