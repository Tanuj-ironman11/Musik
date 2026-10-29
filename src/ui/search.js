// src/ui/search.js
// Global search overlay (opened by shortcut). Searches tracks, artists,
// albums, playlists. Mounted on document.body so it survives view swaps.

window.MusikSearch = (function () {
  let overlayEl = null;
  let inputEl = null;
  let resultsEl = null;
  let sheetEl = null;
  let fieldEl = null;
  let mirrorEl = null;
  let chipEl = null;
  let caretEl = null;
  let thumbEl = null;
  let thumbTimer = null;
  let lastQuery = ''; // survives close/reopen, gone on reload
  let hiliteEl = null;
  let lastPointerX = -1;
  let lastPointerY = -1;
  let isOpen = false;
  let activeIndex = -1;
  let lastTrigger = null;
  let debounceTimer = null;
  let searchToken = 0; // guards against out-of-order async resolution
  let lastTracks = []; // tracks behind the current results, for artist/album actions

  const MIN_SCORE = 2.2;

  // Results row cap across all types combined, once merged into one list.
  const MAX_RESULTS = 9;

  // Picks nudge their own rank next time. Applied after the fuzzy filter, so
  // history can reorder real matches but never resurrect noise.
  const HISTORY_KEY = 'musik.search.history';
  const HISTORY_MAX = 200;
  const HISTORY_HALF_LIFE_DAYS = 14;
  const HISTORY_BOOST_CAP = 8; // stays below what a clearly better match scores
  const HISTORY_QUERIES_KEPT = 3;
  let pickHistory = loadHistory(); // { "type:id": { c: picks, t: lastPickMs, q: [recent queries] } }

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
    } catch (_) { /* no usable history, start empty */ }
    return {};
  }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(pickHistory)); } catch (_) { /* not persisted */ }
  }

  // id: filePath for tracks, playlist id for playlists, the name for artists/albums.
  function historyBoost(type, id, query) {
    const e = pickHistory[`${type}:${id}`];
    if (!e) return 0;
    const ageDays = (Date.now() - e.t) / 86400000;
    const recency = Math.pow(0.5, ageDays / HISTORY_HALF_LIFE_DAYS);
    let boost = Math.log2(1 + e.c) * 2 * recency;
    // Bonus when this is what you picked after typing something like this before.
    const q = query.toLowerCase();
    if (e.q?.some((past) => past.startsWith(q))) boost += 3 * recency;
    return Math.min(boost, HISTORY_BOOST_CAP);
  }

  function recordPick(type, id, query) {
    if (!id) return;
    const key = `${type}:${id}`;
    const e = pickHistory[key] || { c: 0, t: 0, q: [] };
    e.c += 1;
    e.t = Date.now();
    const q = query.toLowerCase();
    if (q) e.q = [q, ...(e.q || []).filter((p) => p !== q)].slice(0, HISTORY_QUERIES_KEPT);
    pickHistory[key] = e;

    const keys = Object.keys(pickHistory);
    if (keys.length > HISTORY_MAX) {
      keys.sort((a, b) => pickHistory[a].t - pickHistory[b].t);
      keys.slice(0, keys.length - HISTORY_MAX).forEach((k) => delete pickHistory[k]);
    }
    saveHistory();
  }

  function clearHistory() {
    pickHistory = {};
    try { localStorage.removeItem(HISTORY_KEY); } catch (_) { /* nothing stored */ }
    return true;
  }

  function buildOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'search-overlay';
    overlayEl.className = 'search-overlay';
    overlayEl.innerHTML = `
      <div class="search-panel">
        <div class="search-field">
          <div class="search-mirror" aria-hidden="true"><span class="search-mirror-text"></span><span class="search-ghost"></span></div>
          <textarea id="search-input" class="search-input" rows="1" aria-label="Search your music" autocomplete="off" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="search-sheet glass-surface glass-surface--elevated" hidden>
        <div id="search-results" class="search-results"></div>
      </div>
      <div class="search-dock">
        <button type="button" class="search-chip" hidden>
          <span class="search-chip-art"></span>
          <span class="search-chip-label"></span>
          <kbd class="search-kbd">\u21B5</kbd>
        </button>
        <button type="button" class="search-actions-pill" aria-haspopup="true" aria-expanded="false">
          <span>Actions</span>
          <span class="search-keys"><kbd class="search-kbd">${modKey()}</kbd><kbd class="search-kbd">K</kbd></span>
        </button>
      </div>
      <div class="search-actions glass-surface glass-surface--elevated" role="dialog" aria-label="Actions" hidden>
        <div class="search-actions-head"></div>
        <div class="search-actions-list" role="listbox"></div>
        <div class="search-actions-filter">
          <input type="text" class="search-actions-input" placeholder="Search actions\u2026" aria-label="Search actions" autocomplete="off" spellcheck="false" />
        </div>
      </div>
    `;

    document.body.appendChild(overlayEl);

    inputEl = overlayEl.querySelector('#search-input');
    resultsEl = overlayEl.querySelector('#search-results');
    sheetEl = overlayEl.querySelector('.search-sheet');
    fieldEl = overlayEl.querySelector('.search-field');
    thumbEl = document.createElement('span');
    thumbEl.className = 'search-scroll-thumb';
    sheetEl.appendChild(thumbEl);
    resultsEl.addEventListener('scroll', flashThumb, { passive: true });
    mirrorEl = overlayEl.querySelector('.search-mirror');
    chipEl = overlayEl.querySelector('.search-chip');
    caretEl = document.createElement('span');
    caretEl.className = 'search-caret';
    hiliteEl = document.createElement('span');
    hiliteEl.className = 'search-hilite';

    chipEl.addEventListener('click', () => {
      overlayEl.querySelectorAll('.search-row')[activeIndex]?.click();
    });
    window.addEventListener('resize', () => { if (isOpen) syncField(); });
    // Arrow keys, Home/End and clicks move the cursor without an input event.
    document.addEventListener('selectionchange', () => {
      if (isOpen && document.activeElement === inputEl) syncField();
    });
    inputEl.addEventListener('input', () => {
      // A textarea accepts pasted line breaks, a search query never needs them.
      if (inputEl.value.includes('\n')) inputEl.value = inputEl.value.replace(/\s*\n+\s*/g, ' ');
      lastQuery = inputEl.value;
      if (actionsOpen) closeActions(false, true);
      syncField();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSearch, 120);
    });
    inputEl.addEventListener('keydown', handleKeydown);
    wireActions();
    reserveActionsKey();
  }

  // Overlay scrollbar: shows scroll position briefly after scrolling.
  function flashThumb() {
    if (!thumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = resultsEl;
    if (scrollHeight <= clientHeight + 1) {
      thumbEl.classList.remove('search-scroll-thumb--on');
      return;
    }
    const inset = 14;
    const track = clientHeight - inset * 2;
    const h = Math.max(30, (track * clientHeight) / scrollHeight);
    const y = inset + (track - h) * (scrollTop / (scrollHeight - clientHeight));
    thumbEl.style.height = `${h}px`;
    thumbEl.style.transform = `translateY(${y}px)`;
    thumbEl.classList.add('search-scroll-thumb--on');
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => thumbEl.classList.remove('search-scroll-thumb--on'), 900);
  }

  // Sync the hidden mirror with the textarea; its height sets the field height.
  function syncField() {
    const value = inputEl.value;
    const pos = Math.min(inputEl.selectionEnd ?? value.length, value.length);
    const textEl = mirrorEl.querySelector('.search-mirror-text');
    textEl.textContent = '';
    textEl.append(value.slice(0, pos), caretEl, value.slice(pos));
    caretEl.classList.toggle('search-caret--hidden', inputEl.selectionStart !== inputEl.selectionEnd);
    mirrorEl.querySelector('.search-ghost').textContent = value ? '' : 'Search your music';
    fieldEl.style.height = `${mirrorEl.offsetHeight}px`;
  }

  // Split artist tags on , ; / & feat. ft. x so each artist matches on its own.
  const ARTIST_SPLIT_RE = /\s*[,;/&]\s*|\s+(?:feat\.?|ft\.?|x)\s+/gi;
  function splitArtists(raw) {
    if (!raw) return [];
    return raw
      .split(ARTIST_SPLIT_RE)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Fuzzy match with a density penalty: scattered letter hits are rejected,
  // tight matches score highest.
  function fuzzyScore(query, target) {
    const q = query.toLowerCase().trim();
    const t = target.toLowerCase();
    if (!q || !t) return -1;

    let qi = 0;
    let score = 0;
    let lastMatch = -1;
    let firstMatch = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        if (firstMatch === -1) firstMatch = ti;
        score += lastMatch === -1 ? 1 : Math.max(1, 4 - (ti - lastMatch));
        lastMatch = ti;
        qi++;
      }
    }
    if (qi < q.length) return -1; // not all query chars matched, no hit

    const isSubstring = t.includes(q);
    const span = lastMatch - firstMatch + 1;
    const density = q.length / span; // 1.0 = perfectly contiguous

    if (isSubstring) score += 10;
    else if (density < 0.45) return -1; // too scattered, treat as noise

    return score * density;
  }

  function fuzzyFilter(items, query, textFn) {
    return items
      .map((item) => ({ item, score: fuzzyScore(query, textFn(item)) }))
      .filter((r) => r.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score);
  }

  // Edit distance, for "Did you mean" when fuzzy match finds nothing.
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const row = [i];
      for (let j = 1; j <= n; j++) {
        row[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
      }
      prev = row;
    }
    return prev[n];
  }

  // Closest title/name for the "Did you mean" hint; only offered when near.
  function findDidYouMean(query, candidates) {
    const q = query.toLowerCase();
    let best = null;
    let bestDist = Infinity;
    for (const name of candidates) {
      if (!name) continue;
      const dist = levenshtein(q, name.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        best = name;
      }
    }
    if (!best) return null;
    const maxAllowed = Math.max(1, Math.floor(q.length * 0.4));
    return bestDist > 0 && bestDist <= maxAllowed ? best : null;
  }

  async function runSearch() {
    const q = inputEl.value.trim();
    const token = ++searchToken;

    if (!q) {
      clearResults();
      return;
    }

    const tracks = (await window.Musik?.library?.getTracks?.()) ?? [];
    const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];

    // Drop stale results if a newer search started.
    if (token !== searchToken) return;

    // Dedupe tracks by filePath (rescans, symlinks).
    const seenPaths = new Set();
    const uniqueTracks = tracks.filter((t) => {
      if (!t.filePath || seenPaths.has(t.filePath)) return false;
      seenPaths.add(t.filePath);
      return true;
    });

    const trackResults = fuzzyFilter(uniqueTracks, q, (t) => `${t.title} ${t.artist || ''} ${t.album || ''}`)
      .map((r) => ({
        type: 'track',
        score: r.score + historyBoost('track', r.item.filePath, q),
        item: r.item,
        label: r.item.title,
        sub: splitArtists(r.item.artist).join(', ') || r.item.artist || '',
      }));

    // Build a deduped set of individual artist names (split on , / ; etc.)
    const artistSet = new Map(); // lowercase -> display name
    for (const t of uniqueTracks) {
      for (const name of splitArtists(t.artist)) {
        const key = name.toLowerCase();
        if (!artistSet.has(key)) artistSet.set(key, name);
      }
    }
    const artistResults = fuzzyFilter([...artistSet.values()], q, (name) => name).map((r) => ({
      type: 'artist',
      score: r.score + historyBoost('artist', r.item, q),
      item: r.item,
      label: r.item,
      sub: '',
    }));

    // Album needs 2+ tracks sharing it; a lone stray tag isn't one.
    const albumCounts = new Map();
    for (const t of uniqueTracks) {
      if (!t.album) continue;
      albumCounts.set(t.album, (albumCounts.get(t.album) || 0) + 1);
    }
    const albumNames = [...albumCounts.entries()].filter(([, count]) => count >= 2).map(([name]) => name);
    const albumResults = fuzzyFilter(albumNames, q, (name) => name).map((r) => ({
      type: 'album',
      score: r.score + historyBoost('album', r.item, q),
      item: r.item,
      label: r.item,
      sub: '',
    }));

    const playlistResults = fuzzyFilter(playlists, q, (p) => p.name).map((r) => ({
      type: 'playlist',
      score: r.score + historyBoost('playlist', r.item.id, q),
      item: r.item,
      label: r.item.name,
      sub: '',
    }));

    // One ranked list across types, tagged by type.
    const merged = [...trackResults, ...artistResults, ...albumResults, ...playlistResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    let suggestion = null;
    if (!merged.length) {
      const candidates = [
        ...uniqueTracks.map((t) => t.title),
        ...artistSet.values(),
        ...albumNames,
        ...playlists.map((p) => p.name),
      ];
      suggestion = findDidYouMean(q, candidates);
    }

    renderResults(merged, uniqueTracks, suggestion);
  }

  const TYPE_LABEL = { track: 'Track', artist: 'Artist', album: 'Album', playlist: 'Playlist' };

  // The results sheet only exists while there's something to show.
  function clearResults() {
    resultsEl.innerHTML = '';
    sheetEl.hidden = true;
    chipEl.hidden = true;
    hiliteEl?.classList.remove('search-hilite--on');
    thumbEl?.classList.remove('search-scroll-thumb--on');
    activeIndex = -1;
  }

  function artSrc(track) {
    const a = track?.artData;
    if (!a?.base64) return null;
    const fmt = a.format || 'jpeg';
    return `data:${fmt.includes('/') ? fmt : `image/${fmt}`};base64,${a.base64}`;
  }

  // Cover for a track/artist/album result.
  function artForResult(r, tracks) {
    let t = null;
    if (r.type === 'track') t = r.item;
    else if (r.type === 'album') t = tracks.find((x) => x.album === r.item && x.artData?.base64);
    else if (r.type === 'artist') t = tracks.find((x) => x.artData?.base64 && splitArtists(x.artist).includes(r.item));
    return artSrc(t);
  }

  // Up to 4 distinct playlist covers (same-album tracks count once).
  function playlistCovers(playlist, byPath) {
    const covers = [];
    const seen = new Set();
    for (const id of playlist.trackIds || []) {
      const a = byPath.get(id)?.artData;
      if (!a?.base64) continue;
      const key = `${a.base64.length}:${a.base64.slice(200, 264)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      covers.push(artSrc({ artData: a }));
      if (covers.length === 4) break;
    }
    return covers;
  }

  // Row cover: playlist cover, else 2x2 of track covers, else a single one.
  function artMarkup(r, tracks, getByPath) {
    const img = (src) => `<img src="${src}" alt="" loading="lazy" decoding="async">`;
    if (r.type === 'playlist') {
      const own = artSrc(r.item);
      if (own) return img(own);
      const covers = playlistCovers(r.item, getByPath());
      if (covers.length >= 4) return `<span class="search-art-grid">${covers.map((c) => img(c)).join('')}</span>`;
      return covers.length ? img(covers[0]) : null;
    }
    const src = artForResult(r, tracks);
    return src ? img(src) : null;
  }

  const TYPE_ICON = {
    track: '<path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/>',
    artist: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
    playlist: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  };

  function renderResults(results, tracks, suggestion) {
    lastTracks = tracks;
    if (actionsOpen) closeActions(false, true);
    sheetEl.hidden = false;
    if (!results.length) {
      chipEl.hidden = true;
      hiliteEl.classList.remove('search-hilite--on');
      resultsEl.innerHTML = suggestion
        ? `<div class="search-empty-hint">
             No matches. Did you mean
             <button type="button" class="search-dym-btn">${escapeHTML(suggestion)}</button>?
           </div>`
        : `<div class="search-empty-hint">No matches.</div>`;
      activeIndex = -1;

      resultsEl.querySelector('.search-dym-btn')?.addEventListener('click', () => {
        inputEl.value = suggestion;
        lastQuery = suggestion;
        syncField();
        inputEl.focus();
        runSearch();
      });
      return;
    }

    const getByPath = (() => {
      let map = null;
      return () => (map ||= new Map(tracks.map((t) => [t.filePath, t])));
    })();

    const rowsHTML = results.map((r, i) => `
      <button class="search-row" data-type="${r.type}"
        ${r.type === 'track' ? `data-track-path="${escapeAttr(r.item.filePath)}"` : ''}
        ${r.type === 'playlist' ? `data-playlist-id="${escapeAttr(r.item.id)}"` : ''}
        ${r.type === 'artist' || r.type === 'album' ? `data-name="${escapeAttr(r.item)}"` : ''}
        style="--row-delay:${i * 18}ms">
        <span class="search-row-art search-row-art--${r.type}">${(() => {
          return artMarkup(r, tracks, getByPath)
            || `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${TYPE_ICON[r.type]}</svg>`;
        })()}</span>
        <span class="search-row-text">
          <span class="search-row-title">${escapeHTML(r.label)}</span>
          ${r.sub ? `<span class="search-row-sub">${escapeHTML(r.sub)}</span>` : ''}
        </span>
        ${r.type === 'track' ? '' : `<span class="search-row-kind">${TYPE_LABEL[r.type]}</span>`}
      </button>
    `);

    resultsEl.innerHTML = rowsHTML.join('');

    // Top result starts active so a bare Enter works.
    activeIndex = 0;
    const rows = resultsEl.querySelectorAll('.search-row');
    rows.forEach((row, i) => {
      row.classList.toggle('search-row--active', i === 0);
      row.addEventListener('click', () => activateRow(row, tracks));
      // Hover sets the active row; real pointer moves only, not rows scrolling under it.
      row.addEventListener('mousemove', (e) => {
        if (actionsOpen) return;
        if (e.clientX === lastPointerX && e.clientY === lastPointerY) return;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        if (activeIndex === i) return;
        activeIndex = i;
        focusRow(Array.from(rows), false);
      });
    });
    resultsEl.prepend(hiliteEl);
    placeHilite(rows[0], true);
    updateChip(rows);
    flashThumb();
  }

  // Slide the highlight to a row; a fresh list snaps instead.
  function placeHilite(row, instant) {
    if (!row) return;
    // Big jumps snap rather than slide.
    const prevY = parseFloat(hiliteEl.style.getPropertyValue('--hl-y')) || 0;
    if (Math.abs(row.offsetTop - prevY) > row.offsetHeight * 1.6) instant = true;
    if (instant) hiliteEl.classList.add('search-hilite--instant');
    hiliteEl.style.setProperty('--hl-y', `${row.offsetTop}px`);
    hiliteEl.style.height = `${row.offsetHeight}px`;
    hiliteEl.classList.add('search-hilite--on');
    if (instant) {
      void hiliteEl.offsetWidth;
      hiliteEl.classList.remove('search-hilite--instant');
    }
  }

  const CHIP_LABEL = { track: 'Play', artist: 'Show in Library', album: 'Show in Library', playlist: 'Open Playlist' };

  // Mirror the active row into the chip.
  function updateChip(rows) {
    const row = rows[activeIndex];
    if (!row) {
      chipEl.hidden = true;
      return;
    }
    const type = row.dataset.type;
    const art = chipEl.querySelector('.search-chip-art');
    art.className = `search-chip-art search-chip-art--${type}`;
    art.innerHTML = row.querySelector('.search-row-art').innerHTML;
    chipEl.querySelector('.search-chip-label').textContent = CHIP_LABEL[type];
    chipEl.hidden = false;
  }

  function activateRow(row, tracks) {
    const type = row.dataset.type;
    recordPick(type, rowPickId(row), inputEl.value.trim());

    // Close first, then act, so the fade doesn't overlap the view swap.
    closeInstant();

    if (type === 'track') {
      const t = tracks.find((tr) => tr.filePath === row.dataset.trackPath);
      if (t && window.MusikPlayerUI) window.MusikPlayerUI.loadTrack(t);
    } else if (type === 'playlist') {
      location.hash = `#/library/${encodeURIComponent(row.dataset.playlistId)}`;
    } else if (type === 'artist' || type === 'album') {
      // No artist/album route yet; go to Library.
      location.hash = `#/library`;
    }
  }

  // Actions panel (Ctrl/Cmd+K): what you can do with the active row, with its shortcut.
  const ACTION_ICON = {
    play: '<path d="M8 5v14l11-7z"/>',
    next: '<path d="M5 5v14l9-7zM18 5v14"/>',
    queue: '<path d="M4 6h12M4 12h8M4 18h6M18 14v6M15 17h6"/>',
    playlist: '<path d="M4 6h16M4 12h10M4 18h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    open: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>',
    art: '<path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5"/>',
    shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22M18 2l4 4-4 4M2 6h1.9c1.5 0 2.9.9 3.6 2.2M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8M18 14l4 4-4 4"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/>',
    person: '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/>',
    disc: '<path d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 15a3 3 0 100-6 3 3 0 000 6z"/>',
    copy: '<path d="M9 9h10a2 2 0 012 2v8a2 2 0 01-2 2H9a2 2 0 01-2-2v-8a2 2 0 012-2zM5 15V5a2 2 0 012-2h10"/>',
  };
  const CHEVRON_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const CHEVRON_RIGHT = `<svg class="search-action-chevron" ${CHEVRON_ATTRS}><path d="M9 6l6 6-6 6"/></svg>`;
  const CHEVRON_LEFT = `<svg ${CHEVRON_ATTRS}><path d="M15 6l-6 6 6 6"/></svg>`;
  const modKey = () => (IS_MAC ? '\u2318' : 'Ctrl');
  const KEY_GLYPH = {
    mod: modKey,
    shift: () => (IS_MAC ? '\u21E7' : 'Shift'),
    alt: () => (IS_MAC ? '\u2325' : 'Alt'),
    enter: () => '\u21B5',
  };
  const keysMarkup = (keys = []) => keys.map((k) => `<kbd class="search-kbd">${KEY_GLYPH[k]()}</kbd>`).join('');

  let actionsEl = null;
  let actionsHeadEl = null;
  let actionsListEl = null;
  let actionsInputEl = null;
  let actionsPillEl = null;
  let actionsCloseTimer = null;
  let actionsOpen = false;
  let actionsView = 'root'; // 'root', or 'playlists' once Add to Playlist is opened
  let actionsItems = []; // everything in the current view
  let actionsShown = []; // after the filter
  let actionsIndex = 0;
  let actionsCtx = null; // the row the panel acts on, see rowContext

  function rowPickId(row) {
    const type = row.dataset.type;
    return type === 'track' ? row.dataset.trackPath
      : type === 'playlist' ? row.dataset.playlistId
      : row.dataset.name;
  }

  function rowContext(row) {
    const type = row.dataset.type;
    const title = row.querySelector('.search-row-title')?.textContent || '';
    if (type === 'track') {
      return { type, row, title, track: lastTracks.find((t) => t.filePath === row.dataset.trackPath) };
    }
    if (type === 'playlist') return { type, row, title, playlist: { id: row.dataset.playlistId, name: title } };
    const name = row.dataset.name;
    const tracks = type === 'album'
      ? lastTracks.filter((t) => t.album === name)
      : lastTracks.filter((t) => splitArtists(t.artist).includes(name));
    return { type, row, title, tracks };
  }

  function playAll(tracks) {
    const ui = window.MusikPlayerUI;
    if (ui) return ui.playQueue?.(tracks) ?? ui.loadTrack(tracks[0]);
  }

  function shuffled(tracks) {
    const a = [...tracks];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Play Next sits each track right after the current one, so go in reverse to keep the order.
  async function enqueueAll(tracks, playNext) {
    const A = window.MusikContextMenu?.actions;
    if (!A) return;
    for (const t of playNext ? [...tracks].reverse() : tracks) await A.enqueue(t, playNext);
  }

  // Re-runs the search for `text` without closing the overlay.
  function searchFor(text) {
    inputEl.value = text;
    lastQuery = text;
    syncField();
    inputEl.focus({ preventScroll: true });
    inputEl.setSelectionRange(text.length, text.length);
    runSearch();
  }

  // `enter` marks the Shift/Alt+Enter quick actions, usable without opening the panel.
  // `stay` actions keep the overlay open; `danger` actions render red.
  function buildActions(ctx) {
    const A = window.MusikContextMenu?.actions;
    const items = [];
    const add = (id, label, run, extra) => items.push({ id, label, run, ...extra });
    const { type, track, playlist, tracks } = ctx;

    if (type === 'track' && track) {
      add('play', 'Play', () => (A?.playTrack ? A.playTrack(track) : window.MusikPlayerUI?.loadTrack(track)), { icon: 'play', keys: ['enter'] });
      if (A) {
        add('next', 'Play Next', () => A.enqueue(track, true), { icon: 'next', keys: ['shift', 'enter'], enter: 'shift' });
        add('queue', 'Add to Queue', () => A.enqueue(track, false), { icon: 'queue', keys: ['alt', 'enter'], enter: 'alt' });
        add('playlist', 'Add to Playlist\u2026', null, { icon: 'playlist', drill: true });
      }
      const artists = splitArtists(track.artist).slice(0, 3);
      artists.forEach((name, i) => add(`artist-${i}`, artists.length > 1 ? `Go to ${name}` : 'Go to Artist', () => searchFor(name), { icon: 'person', stay: true }));
      if (track.album) add('album', 'Go to Album', () => searchFor(track.album), { icon: 'disc', stay: true });
      add('copy', 'Copy Title & Artist', () => navigator.clipboard.writeText([track.artist, track.title].filter(Boolean).join(' - ')), { icon: 'copy' });
      if (A) add('art', 'Refresh Cover Art', () => A.refreshArt(track), { icon: 'art' });
    } else if (type === 'playlist') {
      add('open', 'Open Playlist', () => { location.hash = `#/library/${encodeURIComponent(playlist.id)}`; }, { icon: 'open', keys: ['enter'] });
      if (A) {
        const withTracks = (fn) => async () => {
          const list = await A.playlistTracks(playlist);
          if (list.length) await fn(list);
        };
        const refreshView = () => window.dispatchEvent(new Event('hashchange'));
        add('play-playlist', 'Play', () => A.playPlaylist(playlist), { icon: 'play' });
        add('shuffle-playlist', 'Shuffle', withTracks((list) => playAll(shuffled(list))), { icon: 'shuffle' });
        add('next-playlist', 'Play Next', withTracks((list) => enqueueAll(list, true)), { icon: 'next', keys: ['shift', 'enter'], enter: 'shift' });
        add('queue-playlist', 'Add to Queue', withTracks((list) => enqueueAll(list, false)), { icon: 'queue', keys: ['alt', 'enter'], enter: 'alt' });
        add('rename-playlist', 'Rename\u2026', () => A.renamePlaylist(playlist, refreshView), { icon: 'edit' });
        add('delete-playlist', 'Delete Playlist', () => A.deletePlaylist(playlist, refreshView), { icon: 'trash', danger: true });
      }
    } else if (type === 'artist' || type === 'album') {
      add('open', 'Show in Library', () => { location.hash = '#/library'; }, { icon: 'open', keys: ['enter'] });
      if (tracks.length) {
        add('play-all', 'Play All', () => playAll(tracks), { icon: 'play' });
        add('shuffle-all', 'Shuffle', () => playAll(shuffled(tracks)), { icon: 'shuffle' });
        if (A) {
          add('next-all', 'Play Next', () => enqueueAll(tracks, true), { icon: 'next', keys: ['shift', 'enter'], enter: 'shift' });
          add('queue-all', 'Add All to Queue', () => enqueueAll(tracks, false), { icon: 'queue', keys: ['alt', 'enter'], enter: 'alt' });
          add('playlist-all', 'Add to Playlist\u2026', null, { icon: 'playlist', drill: true });
        }
      }
    }
    return items;
  }

  // Closes the overlay first so dialogs and view changes aren't fighting it.
  async function runAction(item, ctx = actionsCtx) {
    if (!item?.run || !ctx) return;
    closeActions(!!item.stay, true);
    if (!item.stay) {
      recordPick(ctx.type, rowPickId(ctx.row), inputEl.value.trim());
      closeInstant();
    }
    try {
      await item.run();
    } catch (err) {
      console.warn('[Musik] search action failed:', err);
    }
  }

  function renderActions() {
    const q = actionsInputEl.value.trim();
    actionsShown = q ? fuzzyFilter(actionsItems, q, (a) => a.label).map((r) => r.item) : actionsItems;
    actionsIndex = Math.min(actionsIndex, Math.max(actionsShown.length - 1, 0));
    const iconAttrs = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
    actionsListEl.innerHTML = actionsShown.length
      ? actionsShown.map((a, i) => `
          <button type="button" class="search-action${i === actionsIndex ? ' search-action--active' : ''}${a.danger ? ' search-action--danger' : ''}" role="option" tabindex="-1" data-i="${i}">
            <svg class="search-action-icon" ${iconAttrs}>${ACTION_ICON[a.icon] || ''}</svg>
            <span class="search-action-label">${escapeHTML(a.label)}</span>
            ${a.drill ? CHEVRON_RIGHT : `<span class="search-action-keys">${keysMarkup(a.keys)}</span>`}
          </button>`).join('')
      : '<div class="search-empty-hint">Nothing matches.</div>';
  }

  // Keeps the panel under the search bar. A short sheet (1-2 results) grows to
  // give the panel room; the list only shrinks if the window itself is too short.
  function fitActionsList() {
    actionsListEl.style.maxHeight = '';
    const slab = overlayEl.querySelector('.search-panel');
    const dockH = overlayEl.querySelector('.search-dock').offsetHeight;
    const bottom = parseFloat(getComputedStyle(actionsEl).bottom) || 0;
    const panelH = actionsEl.offsetHeight;
    const need = panelH + bottom - dockH - 12; // sheet height that fits the panel
    const cap = window.innerHeight - 16 - overlayEl.getBoundingClientRect().top - slab.offsetHeight - 24 - dockH;
    const grow = Math.min(need, Math.max(cap, 0));
    sheetEl.style.minHeight = `${grow}px`;
    if (need > grow) {
      actionsListEl.style.maxHeight = `${Math.max(96, actionsListEl.offsetHeight - (need - grow))}px`;
    }
  }

  function setActionsView(view, items, title) {
    actionsView = view;
    actionsItems = items;
    actionsIndex = 0;
    actionsInputEl.value = '';
    actionsInputEl.placeholder = view === 'root' ? 'Search actions\u2026' : 'Search playlists\u2026';
    actionsHeadEl.innerHTML = (view === 'root' ? '' : `<button type="button" class="search-actions-back" tabindex="-1" aria-label="Back">${CHEVRON_LEFT}</button>`)
      + `<span class="search-actions-title">${escapeHTML(title)}</span>`;
    renderActions();
    if (actionsOpen) fitActionsList();
  }

  function setActionsIndex(i, scroll) {
    actionsIndex = i;
    actionsListEl.querySelectorAll('.search-action').forEach((el, n) => {
      el.classList.toggle('search-action--active', n === i);
      if (scroll && n === i) el.scrollIntoView({ block: 'nearest' });
    });
  }

  async function openPlaylistView() {
    const A = window.MusikContextMenu?.actions;
    const list = actionsCtx?.track ? [actionsCtx.track] : (actionsCtx?.tracks ?? []);
    if (!A || !list.length) return;
    const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];
    if (!actionsOpen) return;
    setActionsView('playlists', [
      ...playlists.map((p) => ({ id: p.id, label: p.name, icon: 'playlist', run: async () => { for (const t of list) await A.addToPlaylist(p.id, t); } })),
      { id: 'new', label: 'New Playlist\u2026', icon: 'plus', run: () => A.newPlaylistWith(list) },
    ], 'Add to Playlist');
  }

  function backToRootView() {
    setActionsView('root', buildActions(actionsCtx), actionsCtx.title);
  }

  function activateAction(item) {
    if (!item) return;
    if (item.drill) openPlaylistView();
    else runAction(item);
  }

  function openActions() {
    const row = resultsEl.querySelectorAll('.search-row')[activeIndex];
    if (actionsOpen || !row) return;
    const ctx = rowContext(row);
    const items = buildActions(ctx);
    if (!items.length) return;
    actionsCtx = ctx;
    clearTimeout(actionsCloseTimer);
    actionsEl.classList.remove('search-actions--closing');
    setActionsView('root', items, ctx.title);
    actionsEl.hidden = false;
    actionsOpen = true;
    fitActionsList();
    actionsPillEl.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onActionsOutside, true);
    actionsInputEl.focus({ preventScroll: true });
  }

  function closeActions(refocus = true, instant = false) {
    if (!actionsOpen) return;
    actionsOpen = false;
    actionsPillEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onActionsOutside, true);
    if (instant) {
      actionsEl.hidden = true;
      sheetEl.style.minHeight = '';
    } else {
      actionsEl.classList.add('search-actions--closing');
      actionsCloseTimer = setTimeout(() => {
        actionsEl.hidden = true;
        sheetEl.style.minHeight = '';
        actionsEl.classList.remove('search-actions--closing');
      }, 140);
    }
    if (refocus) inputEl.focus({ preventScroll: true });
  }

  // Overlay closing or reopening: drop the panel with no animation.
  function resetActions() {
    if (!actionsEl) return;
    clearTimeout(actionsCloseTimer);
    actionsOpen = false;
    document.removeEventListener('pointerdown', onActionsOutside, true);
    actionsEl.hidden = true;
    sheetEl.style.minHeight = '';
    actionsEl.classList.remove('search-actions--closing');
    actionsPillEl.setAttribute('aria-expanded', 'false');
  }

  function toggleActions() {
    if (actionsOpen) closeActions();
    else openActions();
  }

  function onActionsOutside(e) {
    if (actionsEl.contains(e.target) || actionsPillEl.contains(e.target)) return;
    closeActions(false);
  }

  function onActionsKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation();
      closeActions();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!actionsShown.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActionsIndex((actionsIndex + step + actionsShown.length) % actionsShown.length, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateAction(actionsShown[actionsIndex]);
    } else if (e.key === 'Escape') {
      // One layer at a time: playlists, then the panel, then the overlay.
      e.preventDefault();
      e.stopPropagation();
      if (actionsView === 'root') closeActions();
      else backToRootView();
    } else if (e.key === 'Backspace' && !actionsInputEl.value && actionsView !== 'root') {
      e.preventDefault();
      backToRootView();
    }
  }

  function wireActions() {
    actionsEl = overlayEl.querySelector('.search-actions');
    actionsHeadEl = actionsEl.querySelector('.search-actions-head');
    actionsListEl = actionsEl.querySelector('.search-actions-list');
    actionsInputEl = actionsEl.querySelector('.search-actions-input');
    actionsPillEl = overlayEl.querySelector('.search-actions-pill');

    actionsPillEl.addEventListener('click', toggleActions);
    actionsInputEl.addEventListener('keydown', onActionsKeydown);
    actionsInputEl.addEventListener('input', () => {
      actionsIndex = 0;
      renderActions();
    });
    // Clicking around the panel shouldn't pull focus out of the filter field.
    actionsEl.addEventListener('mousedown', (e) => {
      if (e.target !== actionsInputEl) e.preventDefault();
    });
    actionsListEl.addEventListener('mousemove', (e) => {
      const i = Number(e.target.closest('.search-action')?.dataset.i);
      if (Number.isInteger(i) && i !== actionsIndex) setActionsIndex(i, false);
    });
    actionsListEl.addEventListener('click', (e) => {
      const i = Number(e.target.closest('.search-action')?.dataset.i);
      if (Number.isInteger(i)) activateAction(actionsShown[i]);
    });
    actionsHeadEl.addEventListener('click', (e) => {
      if (e.target.closest('.search-actions-back')) backToRootView();
    });
  }

  // Ctrl/Cmd+K belongs to the panel, so it can't be picked as the open shortcut.
  function reserveActionsKey() {
    window.MusikKeys?.reg('Mod+KeyK', 'Search actions');
  }

  function handleKeydown(e) {
    const rows = Array.from(resultsEl.querySelectorAll('.search-row'));
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation(); // not the open shortcut, even if that's bound to Ctrl+K
      toggleActions();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!rows.length) return;
      activeIndex = Math.min(activeIndex + 1, rows.length - 1);
      focusRow(rows);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      activeIndex = Math.max(activeIndex - 1, 0);
      focusRow(rows);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (!row) return;
      // Shift/Alt+Enter run the quick actions the panel lists with those keys.
      const combo = e.shiftKey ? 'shift' : e.altKey ? 'alt' : null;
      const ctx = combo ? rowContext(row) : null;
      const quick = ctx && buildActions(ctx).find((a) => a.enter === combo);
      if (quick) runAction(quick, ctx);
      else row.click();
    } else if (e.key === 'Escape') {
      close();
    }
  }

  function focusRow(rows, scroll = true) {
    rows.forEach((r, i) => r.classList.toggle('search-row--active', i === activeIndex));
    if (scroll) rows[activeIndex]?.scrollIntoView({ block: 'nearest' });
    placeHilite(rows[activeIndex], false);
    updateChip(rows);
  }

  // No scrim. A press outside closes, and still reaches what's under it.
  function onOutside(e) {
    if (overlayEl.contains(e.target)) return;
    close();
  }

  // opts.trigger (optional): element to refocus on close.
  function open(opts = {}) {
    buildOverlay();
    lastTrigger = opts.trigger || null;
    isOpen = true;
    resetActions();
    document.body.classList.add('search-open');
    document.addEventListener('pointerdown', onOutside, true);
    inputEl.value = lastQuery;
    syncField();
    clearResults();
    if (lastQuery) runSearch();

    requestAnimationFrame(() => {
      overlayEl.classList.add('search-overlay--visible');
    });
    setTimeout(() => {
      inputEl.focus();
      // The old query comes back selected, so typing replaces it.
      if (inputEl.value) inputEl.select();
      syncField();
    }, 60);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    resetActions();
    overlayEl.classList.remove('search-overlay--visible');
    document.body.classList.remove('search-open');
    document.removeEventListener('pointerdown', onOutside, true);

    // Tiny settle bounce on the page underneath, cleared after it plays.
    document.body.classList.add('search-closing-settle');
    setTimeout(() => document.body.classList.remove('search-closing-settle'), 260);

    lastTrigger?.focus?.();
  }

  // Like close() but no fade, for picked results.
  function closeInstant() {
    if (!isOpen) return;
    isOpen = false;
    resetActions();
    overlayEl.classList.add('search-overlay--no-transition');
    overlayEl.classList.remove('search-overlay--visible');
    document.body.classList.remove('search-open');
    document.removeEventListener('pointerdown', onOutside, true);
    // Force reflow so no-transition applies before it's removed.
    void overlayEl.offsetWidth;
    requestAnimationFrame(() => {
      overlayEl.classList.remove('search-overlay--no-transition');
    });
  }

  // Open shortcut. "mod" = Ctrl (Cmd on Mac). Default Mod+Shift+K, saved in
  // localStorage. Matched by e.code, so layout-independent.
  const SHORTCUT_STORAGE_KEY = 'musik.search.shortcut';
  const DEFAULT_SHORTCUT = { mod: true, shift: true, alt: false, code: 'KeyK' };
  const MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  ]);
  const IS_MAC = /Mac/i.test(navigator.platform);
  let shortcut = loadShortcut();
  let capturingShortcut = false;

  function loadShortcut() {
    try {
      const saved = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY));
      if (saved && typeof saved.code === 'string') {
        return { mod: !!saved.mod, shift: !!saved.shift, alt: !!saved.alt, code: saved.code };
      }
    } catch (_) { /* no saved shortcut, use the default */ }
    return { ...DEFAULT_SHORTCUT };
  }

  function matchesShortcut(e) {
    return e.code === shortcut.code
      && (e.ctrlKey || e.metaKey) === shortcut.mod
      && e.shiftKey === shortcut.shift
      && e.altKey === shortcut.alt;
  }

  const KEY_LABELS = {
    Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-',
    Equal: '=', Backquote: '`',
  };

  function formatShortcut(s = shortcut) {
    const key = s.code.startsWith('Key') ? s.code.slice(3)
      : s.code.startsWith('Digit') ? s.code.slice(5)
      : KEY_LABELS[s.code] || s.code;
    const parts = [];
    if (s.mod) parts.push(IS_MAC ? 'Cmd' : 'Ctrl');
    if (s.alt) parts.push(IS_MAC ? 'Option' : 'Alt');
    if (s.shift) parts.push('Shift');
    parts.push(key);
    return parts.join('+');
  }

  // Returns { ok, label } or { ok: false, reason, label? }. Needs Mod or Alt; blocks built-ins.
  function setShortcut(next) {
    if (!next || typeof next.code !== 'string' || MODIFIER_CODES.has(next.code)) {
      return { ok: false, reason: 'invalid' };
    }
    const candidate = { mod: !!next.mod, shift: !!next.shift, alt: !!next.alt, code: next.code };
    if (!candidate.mod && !candidate.alt) return { ok: false, reason: 'needs-modifier' };
    const hit = window.MusikKeys?.find(candidate);
    if (hit) return { ok: false, reason: 'conflict', label: hit };
    shortcut = candidate;
    try { localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcut)); } catch (_) { /* not persisted */ }
    return { ok: true, label: formatShortcut() };
  }

  function resetShortcut() {
    shortcut = { ...DEFAULT_SHORTCUT };
    try { localStorage.removeItem(SHORTCUT_STORAGE_KEY); } catch (_) { /* nothing stored */ }
    return { ok: true, label: formatShortcut() };
  }

  // Waits for a key combo and sets it (Esc cancels). onProgress gets live modifier text.
  let cancelCapture = null;

  function captureShortcut(onProgress) {
    cancelCapture?.();
    return new Promise((resolve) => {
      capturingShortcut = true;
      const finish = (result) => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('keyup', onKeyUp, true);
        capturingShortcut = false;
        cancelCapture = null;
        resolve(result);
      };
      const progress = (e) => {
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push(IS_MAC ? 'Cmd' : 'Ctrl');
        if (e.altKey) parts.push(IS_MAC ? 'Option' : 'Alt');
        if (e.shiftKey) parts.push('Shift');
        onProgress?.(parts.length ? `${parts.join('+')}+\u2026` : '');
      };
      const onKeyUp = (e) => {
        if (!MODIFIER_CODES.has(e.code)) return;
        e.preventDefault();
        progress(e);
      };
      const onKey = (e) => {
        if (MODIFIER_CODES.has(e.code)) {
          e.preventDefault();
          progress(e);
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (e.code === 'Escape') {
          finish({ ok: false, reason: 'cancelled' });
          return;
        }
        finish(setShortcut({ mod: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, code: e.code }));
      };
      cancelCapture = () => finish({ ok: false, reason: 'cancelled' });
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('keyup', onKeyUp, true);
    });
  }

  // Works from any view.
  document.addEventListener('keydown', (e) => {
    if (capturingShortcut || !matchesShortcut(e)) return;
    e.preventDefault();

    if (isOpen) {
      close();
      return;
    }
    open();
  });

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(str) {
    return escapeHTML(str);
  }

  reserveActionsKey();

  return {
    open,
    close,
    getShortcutLabel: () => formatShortcut(),
    setShortcut,
    resetShortcut,
    captureShortcut,
    cancelShortcutCapture: () => cancelCapture?.(),
    clearHistory,
  };
})();
