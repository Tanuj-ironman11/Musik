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
// silently. Avatar source files are capped client-side at 8MB before
// reading, and the saved image is a re-encoded 320px JPEG crop (tens of
// KB), which is what actually keeps localStorage (5-10MB browser-enforced
// quota) from filling up.
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

// Splits a raw artist tag on UNAMBIGUOUS multi-artist separators only:
// ";" and feat./ft./featuring/x. Deliberately NOT "," "&" or "/" — those
// are part of real names (AC/DC, Earth, Wind & Fire, Simon & Garfunkel,
// Tyler, The Creator), and splitting on them showed "AC", "Earth", "Simon"
// and "Tyler" as the artist. Kept independent of search.js's splitArtists
// since this file doesn't load search.js (search.js's copy still has the
// old, greedier pattern — flagged separately).
const ARTIST_SPLIT_RE = /\s*;\s*|\s+(?:feat\.?|ft\.?|featuring|x)\s+/gi;
function splitArtists(raw) {
  if (!raw) return [];
  return raw.split(ARTIST_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

// Merges topArtists entries that are really the same person credited
// differently across tracks — "A;B" and "A;C" both get folded into "A"
// (the primary/first-listed artist), instead of showing as two separate
// rows that split what should be one person's play count. Grouped by a
// normalized key: lowercased, punctuation stripped, whitespace collapsed,
// on the primary artist's WHOLE name — catches "DJ Snake" vs "dj  snake"
// too, not just the collab-splitting case.
// Two bugs fixed here: (1) the old key kept only the first two words, so
// "The Kid LAROI" and "The Kid Cudi" merged into one row; the whole
// normalized name is the key now. (2) the old [^a-z0-9] strip erased every
// non-Latin character, so Japanese/Korean/Chinese/Cyrillic artists
// normalized to "" and were silently dropped from Top Artists. \p{L}/\p{N}
// keeps letters and digits in any script.
function normalizeArtistKey(name) {
  const primary = splitArtists(name)[0] || name || '';
  return primary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .split(/\s+/)
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

// In-app dialog instead of the native alert() (which can steal input focus
// in Electron). Falls back to alert only if MusikDialog isn't loaded.
function notify(message) {
  if (window.MusikDialog?.alert) return window.MusikDialog.alert(message);
  alert(message);
}

// ── Motion helpers ──────────────────────────────────────────────────
// Numbers are rendered at their final value in the HTML (so nothing breaks
// without JS), then countUp() rewinds to 0 and eases up to it.
function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function fmtCount(n) {
  return Math.round(n).toLocaleString();
}

function numHTML(value, fmt = 'num') {
  const v = Number(value) || 0;
  const shown = fmt === 'dur' ? fmtDuration(v) : fmtCount(v);
  return `<span class="profile-stat-num" data-count="${v}" data-fmt="${fmt}">${shown}</span>`;
}

function countUp(el) {
  const target = Number(el.dataset.count) || 0;
  const fmt = el.dataset.fmt === 'dur' ? fmtDuration : fmtCount;
  if (prefersReducedMotion() || target <= 0) { el.textContent = fmt(target); return; }
  const start = performance.now();
  const DURATION = 750;
  el.textContent = fmt(0);
  const tick = (now) => {
    const p = Math.min(1, (now - start) / DURATION);
    el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1 && el.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function runCountUps(root) {
  root.querySelectorAll('[data-count]').forEach(countUp);
}

// Restarts a one-shot CSS animation class (same pattern as settings.js).
function kick(el) {
  if (!el) return;
  el.classList.remove('is-kick');
  void el.getBoundingClientRect();
  el.classList.add('is-kick');
  el.addEventListener('animationend', () => el.classList.remove('is-kick'), { once: true });
}

// ── Top lists ──────────────────────────────────────────────────────
// key format for albums/tracks is "artist::name" (see libraryStatsHTML too).
// Two separate maps — a track titled the same as its album (very common for
// singles / self-titled releases) used to share one key and could hand the
// track row the wrong art.
function buildArtLookup(tracks) {
  const album = new Map();
  const track = new Map();
  for (const t of tracks || []) {
    const artist = t.artist || '';
    if (t.album && !album.has(`${artist}::${t.album}`)) album.set(`${artist}::${t.album}`, t);
    if (t.title && !track.has(`${artist}::${t.title}`)) track.set(`${artist}::${t.title}`, t);
  }
  return { album, track };
}

const NOTE_GLYPH = `<svg class="profile-top-thumb-glyph" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>`;

function topThumbHTML(kind, label, key, artLookup) {
  if (kind === 'artist') {
    const initial = Array.from(label)[0]?.toUpperCase() || '?';
    return `<span class="profile-top-thumb profile-top-thumb--artist">${escapeHTML(initial)}</span>`;
  }
  let src = '';
  try {
    const t = artLookup?.[kind]?.get(key);
    src = (t && window.MusikCards?.artSrc?.(t)) || '';
  } catch { src = ''; }
  // Glyph sits underneath; a failed <img> is removed (wired after insert —
  // inline onerror would trip the CSP) and the glyph shows through.
  return `<span class="profile-top-thumb">${NOTE_GLYPH}${src ? `<img src="${escapeHTML(src)}" alt="" loading="lazy">` : ''}</span>`;
}

function topListHTML(items, emptyLabel, kind, artLookup) {
  if (!items?.length) return `<div class="profile-top-empty">${escapeHTML(emptyLabel)}</div>`;
  const rows = items.slice(0, 5);
  const max = Math.max(...rows.map((r) => r.count), 1);
  return `<ol class="profile-top-list">${rows.map((item, i) => {
    const hasPrefix = item.key.includes('::');
    const parts = item.key.split('::');
    const name = hasPrefix ? (parts.slice(1).join('::') || item.key) : item.key;
    const sub = hasPrefix ? parts[0] : '';
    const pct = Math.max(6, Math.round((item.count / max) * 100));
    return `
      <li class="profile-top-row${i === 0 ? ' is-first' : ''}" style="--i:${i}; --pct:${pct}%">
        <span class="profile-top-bar" aria-hidden="true"></span>
        <span class="profile-top-rank">${i + 1}</span>
        ${topThumbHTML(kind, name, item.key, artLookup)}
        <span class="profile-top-text">
          <span class="profile-top-name">${escapeHTML(name)}</span>
          ${sub ? `<span class="profile-top-sub">${escapeHTML(sub)}</span>` : ''}
        </span>
        <span class="profile-top-count">${fmtCount(item.count)}</span>
      </li>`;
  }).join('')}</ol>`;
}

// ── Library stats (collapsible card, independent of the stats source) ──
function libraryStatsHTML(tracks) {
  if (!tracks.length) return `<div class="profile-lib-empty">No tracks in your library yet.</div>`;

  const artists = new Set(tracks.map((t) => (t.artist || '').trim().toLowerCase()).filter(Boolean));
  const albums = new Set(tracks.filter((t) => t.album).map((t) => `${(t.artist || '').toLowerCase()}::${t.album.toLowerCase()}`));
  const totalSeconds = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  const formatCounts = {};
  for (const t of tracks) {
    const ext = (t.filePath?.split('.').pop() || 'other').toLowerCase();
    formatCounts[ext] = (formatCounts[ext] || 0) + 1;
  }
  const formats = Object.entries(formatCounts).sort((a, b) => b[1] - a[1]);

  const stat = (value, label, fmt) => `
    <div class="profile-lib-stat">
      <span class="profile-lib-num">${numHTML(value, fmt)}</span>
      <span class="profile-lib-label">${label}</span>
    </div>`;

  return `
    <div class="profile-lib-grid">
      ${stat(tracks.length, 'Tracks')}
      ${stat(artists.size, 'Artists')}
      ${stat(albums.size, 'Albums')}
      ${stat(totalSeconds, 'Total length', 'dur')}
    </div>
    <div class="profile-fmt-bar" aria-hidden="true">
      ${formats.map(([, count], i) => `<span class="profile-fmt-seg" style="--k:${Math.min(i, 5)}; flex:${count}"></span>`).join('')}
    </div>
    <div class="profile-lib-formats">
      ${formats.map(([ext, count], i) => `
        <span class="profile-lib-format-pill" style="--k:${Math.min(i, 5)}">
          <i class="profile-lib-format-dot"></i>${escapeHTML(ext.toUpperCase())} · ${fmtCount(count)}
        </span>`).join('')}
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
const LASTFM_TIMEOUT_MS = 6000; // don't leave "Loading stats..." up forever if Last.fm is slow/offline

function getSavedAvatar() {
  try { return localStorage.getItem(AVATAR_KEY) || null; } catch { return null; }
}
function getSavedUsername() {
  try { return localStorage.getItem(USERNAME_KEY) || ''; } catch { return ''; }
}

// Array.from splits by code point, so an emoji or non-BMP character isn't
// cut in half the way parts[0][0] (a UTF-16 unit) would.
function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = (p) => Array.from(p || '')[0] || '';
  return (first(parts[0]) + first(parts[1])).toUpperCase();
}

// Initials when there's a name, a generic person glyph when there isn't —
// an empty circle gave no hint that it's clickable.
function avatarFallbackHTML(name) {
  const i = initials(name);
  if (i) return escapeHTML(i);
  return `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
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
          <button type="button" class="avatar-crop-btn avatar-crop-btn--save" id="avatar-crop-save" disabled>Save photo</button>
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
      saveBtn.disabled = false; // saving before decode gave a blank image
    };
    // Files the browser can't decode (HEIC, corrupt, mislabeled) never fire
    // onload — without this the modal sat open on an empty circle forever.
    img.onerror = () => {
      cleanup();
      notify("Couldn't read that image — try a JPG or PNG.");
      resolve(null);
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

    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    };
    document.addEventListener('keydown', onKey, true);

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
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

// Filled in once stats load; renderProfileHeader repaints the chips from it
// so an avatar/name change never has to wait on (or re-fetch) the stats.
let heroInfo = null;

function paintHeroChips() {
  const el = document.getElementById('profile-chips');
  if (!el) return;
  if (!heroInfo) { el.innerHTML = ''; return; }
  const chips = [];
  if (heroInfo.since) chips.push(`<span class="profile-chip">Listening since ${escapeHTML(fmtDate(heroInfo.since))}</span>`);
  chips.push(`<span class="profile-chip">${fmtCount(heroInfo.trackCount)} track${heroInfo.trackCount === 1 ? '' : 's'}</span>`);
  if (heroInfo.lastfm) chips.push(`<span class="profile-chip profile-chip--live"><i class="profile-chip-dot"></i>Last.fm connected</span>`);
  el.innerHTML = chips.join('');
}

function renderProfileHeader(container) {
  const savedName = getSavedUsername();
  const savedAvatar = getSavedAvatar();

  container.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar-wrap" id="profile-avatar-wrap" title="Click to change photo" role="button" tabindex="0" aria-label="Change profile photo">
        ${savedAvatar
          ? `<img class="profile-avatar-img" id="profile-avatar-img" src="${savedAvatar}" alt="Profile photo">`
          : `<div class="profile-avatar-fallback" id="profile-avatar-fallback">${avatarFallbackHTML(savedName)}</div>`}
        <div class="profile-avatar-overlay">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </div>
        <input type="file" id="profile-avatar-input" accept="image/*" hidden>
      </div>
      <div class="profile-identity">
        <input type="text" class="profile-username-input" id="profile-username-input"
               placeholder="Your name" maxlength="32" value="${escapeHTML(savedName)}" spellcheck="false" aria-label="Username">
        <div class="profile-identity-sub">Your Musik profile · saved on this device</div>
        <div class="profile-chips" id="profile-chips"></div>
      </div>
    </div>
  `;
  paintHeroChips();

  const avatarWrap = container.querySelector('#profile-avatar-wrap');
  const avatarInput = container.querySelector('#profile-avatar-input');
  const usernameInput = container.querySelector('#profile-username-input');

  // e.target guard: the hidden <input> lives inside the wrap, so its own
  // synthetic click bubbles back up here — ignore that re-entry.
  avatarWrap?.addEventListener('click', (e) => {
    if (e.target === avatarInput) return;
    avatarInput?.click();
  });
  avatarWrap?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      avatarInput?.click();
    }
  });

  avatarInput?.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    avatarInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { notify('Please choose an image file.'); return; }
    if (file.size > MAX_AVATAR_SOURCE_BYTES) { notify('That image is over 8MB — try a smaller one.'); return; }
    const cropped = await openAvatarCropper(file);
    if (!cropped) return;
    try { localStorage.setItem(AVATAR_KEY, cropped); } catch { notify("Couldn't save that photo (storage full?)."); return; }
    renderProfileHeader(container);
  });

  let nameTimer = null;
  usernameInput?.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      try { localStorage.setItem(USERNAME_KEY, usernameInput.value.trim()); } catch {}
    }, 300);
    const fallback = document.getElementById('profile-avatar-fallback');
    if (fallback) fallback.innerHTML = avatarFallbackHTML(usernameInput.value);
  });
}

// ── Source toggle ──────────────────────────────────────────────────
// Same construction as settings.js's layout toggle (sliding thumb on
// `translate`, squash kick, icon kick on the newly selected option) — but
// text + icon options, and the toggle is updated IN PLACE: it lives outside
// the re-rendered content, so the thumb really slides instead of being
// recreated at its destination.
function sourceToggleHTML(source) {
  const opt = (id, label, icon) => `
    <button type="button" class="profile-source-btn" data-source="${id}" aria-pressed="${source === id}">
      ${icon}<span>${label}</span>
    </button>`;
  const localIcon = `<svg class="profile-src-icon profile-src-icon--local" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="7" rx="1.6"/><path d="M1.5 13h13"/></svg>`;
  const fmIcon = `<svg class="profile-src-icon profile-src-icon--fm" viewBox="0 0 16 16" aria-hidden="true"><rect class="fm-bar" style="--i:0" x="2" y="7" width="2.6" height="7" rx="1.1"/><rect class="fm-bar" style="--i:1" x="6.7" y="2" width="2.6" height="12" rx="1.1"/><rect class="fm-bar" style="--i:2" x="11.4" y="5" width="2.6" height="9" rx="1.1"/></svg>`;
  return `
    <div class="profile-source-toggle" id="profile-source-toggle" role="group" aria-label="Stats source" data-source="${source}">
      <span class="profile-source-thumb" aria-hidden="true"></span>
      ${opt('local', 'Local', localIcon)}
      ${opt('lastfm', 'Last.fm', fmIcon)}
    </div>`;
}

// ── Stats content (session + lifetime + top lists) ─────────────────
function renderStatsContent(content, { source, session, localLifetime, lastfmLifetime, artLookup }) {
  const usingLastfm = source === 'lastfm' && !!lastfmLifetime;
  const lifetime = usingLastfm ? lastfmLifetime : localLifetime;

  // Lifetime "Plays" switches with the source but "Listened" never does
  // (Last.fm has no duration), so with Last.fm selected the two numbers come
  // from different places — say so instead of leaving it looking like a bug.
  const footnoteParts = [];
  if (usingLastfm) {
    footnoteParts.push(`Play counts come from Last.fm. Listening time is tracked by Musik on this device, since Last.fm doesn't provide it.`);
    if (localLifetime?.lastfmConnectedAt && localLifetime?.firstTrackedAt && localLifetime.firstTrackedAt < localLifetime.lastfmConnectedAt) {
      footnoteParts.push(`Musik also tracked ${localLifetime.totalPlays} play${localLifetime.totalPlays === 1 ? '' : 's'} locally starting ${escapeHTML(fmtDate(localLifetime.firstTrackedAt))}, before you connected Last.fm on ${escapeHTML(fmtDate(localLifetime.lastfmConnectedAt))}.`);
    }
  }
  const footnoteHTML = footnoteParts.length ? `<div class="profile-footnote">${footnoteParts.join(' ')}</div>` : '';

  const topArtists = dedupeTopArtists(lifetime?.topArtists);

  content.innerHTML = `
    <div class="profile-grid">
      <section class="profile-card">
        <div class="profile-card-label">This session</div>
        <div class="profile-card-main">
          <div class="profile-stat">${numHTML(session?.plays ?? 0)}<span class="profile-stat-label">Plays</span></div>
          <div class="profile-stat">${numHTML(session?.seconds ?? session?.totalSeconds ?? 0, 'dur')}<span class="profile-stat-label">Listened</span></div>
        </div>
      </section>
      <section class="profile-card">
        <div class="profile-card-label">Lifetime <span class="profile-source-tag">${usingLastfm ? 'Last.fm' : 'local'}</span></div>
        <div class="profile-card-main">
          <div class="profile-stat">${numHTML(lifetime?.totalPlays ?? 0)}<span class="profile-stat-label">Plays</span></div>
          <div class="profile-stat">${numHTML(localLifetime?.totalSeconds ?? 0, 'dur')}<span class="profile-stat-label">Listened</span></div>
        </div>
        ${footnoteHTML}
      </section>
    </div>

    <div class="profile-top-grid">
      <section class="profile-card">
        <div class="profile-card-label">Top artists</div>
        ${topListHTML(topArtists, 'Play some music to see your top artists.', 'artist', artLookup)}
      </section>
      <section class="profile-card">
        <div class="profile-card-label">Top albums</div>
        ${topListHTML(lifetime?.topAlbums, 'No albums yet.', 'album', artLookup)}
      </section>
      <section class="profile-card">
        <div class="profile-card-label">Top tracks</div>
        ${topListHTML(lifetime?.topTracks, 'No tracks yet.', 'track', artLookup)}
      </section>
    </div>
  `;

  content.querySelectorAll('.profile-card').forEach((card, i) => card.style.setProperty('--i', i));
  content.querySelectorAll('.profile-top-thumb img').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
  runCountUps(content);
}

function renderStatsSection(container, { source: initialSource, session, localLifetime, lastfmLifetime, connected, tracks }) {
  let source = initialSource;
  const artLookup = buildArtLookup(tracks);

  const toggleHTML = connected
    ? sourceToggleHTML(source)
    : `<div class="profile-source-hint"><span class="profile-source-tag">local</span><span>Connect Last.fm in <a href="#/settings">Settings</a> for all-time totals.</span></div>`;

  container.innerHTML = `
    <div class="profile-toolbar">
      <h2 class="profile-section-title">Your stats</h2>
      ${toggleHTML}
    </div>
    <div id="profile-stats-content"></div>
    <section class="profile-card profile-lib-card" style="--i:5">
      <button type="button" class="profile-card-label profile-lib-toggle" id="profile-lib-toggle" aria-expanded="false">
        <span>Library stats</span>
        <svg class="profile-lib-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="profile-lib-content" id="profile-lib-content">
        ${libraryStatsHTML(tracks || [])}
      </div>
    </section>
  `;

  const content = container.querySelector('#profile-stats-content');
  const paint = () => renderStatsContent(content, { source, session, localLifetime, lastfmLifetime, artLookup });
  paint();

  const toggle = container.querySelector('#profile-source-toggle');
  toggle?.addEventListener('click', (e) => {
    const btn = e.target.closest('.profile-source-btn');
    if (!btn) return;
    const next = btn.dataset.source;
    if (next === source) return;
    source = next;
    try { localStorage.setItem('musik.profile.statsSource', next); } catch {}

    toggle.dataset.source = next;
    toggle.querySelectorAll('.profile-source-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    kick(toggle.querySelector('.profile-source-thumb'));
    kick(btn.querySelector('.profile-src-icon'));

    paint();
  });

  const libToggle = container.querySelector('#profile-lib-toggle');
  const libContent = container.querySelector('#profile-lib-content');
  let libCounted = false;
  libToggle?.addEventListener('click', () => {
    const open = libToggle.classList.toggle('is-open');
    libContent?.classList.toggle('is-open', open);
    libToggle.setAttribute('aria-expanded', String(open));
    // Count the numbers up the first time the card is actually seen.
    if (open && !libCounted && libContent) { libCounted = true; runCountUps(libContent); }
  });
}

// Feeds the hover spotlight in profile.css (.profile-card::after) — same
// cursor-tracking trick as settings.js.
function trackSpotlight(e) {
  const card = e.target.closest?.('.profile-card, .profile-hero');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
}

window.MusikViews.profile = async function renderProfile(main) {
  main.innerHTML = `
    <div class="home-wrap profile-wrap">
      <div class="home-topbar"><h1 class="view-title">Profile</h1></div>
      <div id="profile-header"></div>
      <div id="profile-body" class="profile-loading">Loading stats...</div>
    </div>
  `;
  main.querySelector('.profile-wrap')?.addEventListener('pointermove', trackSpotlight, { passive: true });

  heroInfo = null;
  renderProfileHeader(main.querySelector('#profile-header'));

  let session = null, localLifetime = null, scrobbleSettings = null, tracks = [];
  try {
    [session, localLifetime, scrobbleSettings, tracks] = await Promise.all([
      window.Musik?.stats?.getSession?.() ?? null,
      window.Musik?.stats?.getLifetime?.() ?? null,
      window.Musik?.scrobble?.getSettings?.() ?? null,
      window.Musik?.library?.getTracks?.() ?? [],
    ]);
  } catch (err) {
    // One failed IPC call used to leave the page stuck on "Loading stats...".
    console.warn('[Musik] profile: stats load failed:', err?.message || err);
  }
  tracks = tracks || [];

  const connected = !!scrobbleSettings?.connected;
  let lastfmLifetime = null;
  if (connected) {
    try {
      lastfmLifetime = await Promise.race([
        window.Musik?.scrobble?.getLifetimeStats?.(),
        new Promise((resolve) => setTimeout(() => resolve(null), LASTFM_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn('[Musik] profile: Last.fm lifetime stats failed:', err?.message || err);
    }
  }

  // The user may have navigated away while the awaits above were pending —
  // the view is gone, so bail instead of throwing on a null element.
  const body = main.querySelector('#profile-body');
  if (!body) return;
  body.className = '';

  heroInfo = {
    since: localLifetime?.firstTrackedAt || null,
    trackCount: tracks.length,
    lastfm: connected && !!lastfmLifetime,
  };
  paintHeroChips();

  let savedSource = 'local';
  try { savedSource = localStorage.getItem('musik.profile.statsSource') || 'local'; } catch {}
  const source = connected && lastfmLifetime && savedSource === 'lastfm' ? 'lastfm' : 'local';

  renderStatsSection(body, { source, session, localLifetime, lastfmLifetime, connected: connected && !!lastfmLifetime, tracks });
};
