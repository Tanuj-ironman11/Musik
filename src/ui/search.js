// src/ui/search.js
//
// Global search overlay. Opened via the sidebar's search nav item (see
// wireSearchTrigger in app.js) or Ctrl/Cmd+K from anywhere. Searches
// tracks, artists, albums, and playlists — not settings, there's not
// enough settings surface yet to justify indexing it.
//
// Overlay markup is appended directly to document.body (not #main) so
// it survives view swaps and always renders above everything else.

window.MusikSearch = (function () {
  let overlayEl = null;
  let backdropEl = null;
  let inputEl = null;
  let resultsEl = null;
  let isOpen = false;
  let activeIndex = -1;
  let lastTrigger = null;
  let debounceTimer = null;
  let searchToken = 0; // guards against out-of-order async resolution

  const MIN_SCORE = 2.2;

  // Results row cap across all types combined, once merged into one list.
  const MAX_RESULTS = 9;

  function buildOverlay() {
    if (overlayEl) return;

    backdropEl = document.createElement('div');
    backdropEl.id = 'search-backdrop';
    backdropEl.className = 'search-backdrop';

    overlayEl = document.createElement('div');
    overlayEl.id = 'search-overlay';
    overlayEl.className = 'search-overlay';
    overlayEl.innerHTML = `
      <div class="search-panel glass-surface glass-surface--elevated">
        <div class="search-panel-corner search-panel-corner--tl"></div>
        <div class="search-panel-corner search-panel-corner--tr"></div>
        <div class="search-panel-corner search-panel-corner--bl"></div>
        <div class="search-panel-corner search-panel-corner--br"></div>
        <div class="search-input-row">
          <svg class="search-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input type="text" id="search-input" class="search-input" placeholder="Search tracks, artists, albums, playlists…" autocomplete="off" spellcheck="false">
          <kbd class="search-esc-hint">ESC</kbd>
        </div>
        <div id="search-results" class="search-results"></div>
      </div>
    `;

    document.body.appendChild(backdropEl);
    document.body.appendChild(overlayEl);

    inputEl = overlayEl.querySelector('#search-input');
    resultsEl = overlayEl.querySelector('#search-results');

    backdropEl.addEventListener('click', close);
    inputEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSearch, 120);
    });
    inputEl.addEventListener('keydown', handleKeydown);
  }

  // Splits a raw artist tag on common multi-artist separators (",", ";",
  // "/", "&", " feat. ", " ft. ", " x "). Most taggers cram collabs into
  // one string ("Skrillex; Boys Noize") and we want each artist to be
  // its own searchable/matchable entity rather than one long blob that
  // only matches if you type it verbatim in full.
  const ARTIST_SPLIT_RE = /\s*[,;/&]\s*|\s+(?:feat\.?|ft\.?|x)\s+/gi;
  function splitArtists(raw) {
    if (!raw) return [];
    return raw
      .split(ARTIST_SPLIT_RE)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Fuzzy match with a density penalty. Query characters must still
  // appear in order somewhere in the target, but matches where those
  // characters are scattered far apart relative to the query length
  // (e.g. "my jam" loosely hitting letters inside "firestorm") get
  // rejected instead of ranked low — low-ranked garbage still shows up
  // once you're past the first couple of matches, which is the actual
  // bug. Tight/contiguous matches and real substrings still score highest.
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

  // Plain edit-distance, used only for "Did you mean" when the fuzzy
  // matcher above comes up empty — that matcher is subsequence-based and
  // deliberately strict now, so it's the wrong tool for "close but
  // misspelled". Levenshtein is what actually answers "how different is
  // this word from what they typed".
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

  // Finds the single closest candidate name/title across everything
  // searchable, for a "Did you mean" hint when the real search draws a
  // blank. Only offered when it's actually close (distance small relative
  // to word length) — otherwise "did you mean" for a totally unrelated
  // word is more annoying than just saying no matches.
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
      resultsEl.innerHTML = `<div class="search-empty-hint">Start typing to search your library…</div>`;
      activeIndex = -1;
      return;
    }

    const tracks = (await window.Musik?.library?.getTracks?.()) ?? [];
    const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];

    // Bail if a newer search has started since we began awaiting — avoids
    // a slow response clobbering a faster, more recent one.
    if (token !== searchToken) return;

    // Dedupe tracks by filePath before matching — duplicate library
    // entries (rescans, symlinked folders, etc.) shouldn't show twice.
    const seenPaths = new Set();
    const uniqueTracks = tracks.filter((t) => {
      if (!t.filePath || seenPaths.has(t.filePath)) return false;
      seenPaths.add(t.filePath);
      return true;
    });

    const trackResults = fuzzyFilter(uniqueTracks, q, (t) => `${t.title} ${t.artist || ''} ${t.album || ''}`)
      .map((r) => ({
        type: 'track',
        score: r.score,
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
      score: r.score,
      item: r.item,
      label: r.item,
      sub: '',
    }));

    // Only count something as an "album" if 2+ tracks actually share it —
    // a lone track with a stray/unique album tag in its metadata (a common
    // junk-metadata case) isn't a real album and shouldn't show up as a
    // search result type of its own.
    const albumCounts = new Map();
    for (const t of uniqueTracks) {
      if (!t.album) continue;
      albumCounts.set(t.album, (albumCounts.get(t.album) || 0) + 1);
    }
    const albumNames = [...albumCounts.entries()].filter(([, count]) => count >= 2).map(([name]) => name);
    const albumResults = fuzzyFilter(albumNames, q, (name) => name).map((r) => ({
      type: 'album',
      score: r.score,
      item: r.item,
      label: r.item,
      sub: '',
    }));

    const playlistResults = fuzzyFilter(playlists, q, (p) => p.name).map((r) => ({
      type: 'playlist',
      score: r.score,
      item: r.item,
      label: r.item.name,
      sub: '',
    }));

    // Merge into one ranked list instead of type-sectioned groups —
    // best match wins regardless of what kind of thing it is, with a
    // small colored tag identifying the type.
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

  function renderResults(results, tracks, suggestion) {
    if (!results.length) {
      resultsEl.innerHTML = suggestion
        ? `<div class="search-empty-hint">
             No matches. Did you mean
             <button type="button" class="search-dym-btn">${escapeHTML(suggestion)}</button>?
           </div>`
        : `<div class="search-empty-hint">No matches.</div>`;
      activeIndex = -1;

      resultsEl.querySelector('.search-dym-btn')?.addEventListener('click', () => {
        inputEl.value = suggestion;
        inputEl.focus();
        runSearch();
      });
      return;
    }

    const rowsHTML = results.map((r, i) => `
      <button class="search-row" data-type="${r.type}"
        ${r.type === 'track' ? `data-track-path="${escapeAttr(r.item.filePath)}"` : ''}
        ${r.type === 'playlist' ? `data-playlist-id="${escapeAttr(r.item.id)}"` : ''}
        ${r.type === 'artist' || r.type === 'album' ? `data-name="${escapeAttr(r.item)}"` : ''}
        style="--row-delay:${i * 18}ms">
        <span class="search-tag search-tag--${r.type}">${TYPE_LABEL[r.type]}</span>
        <span class="search-row-text">
          <span class="search-row-title">${escapeHTML(r.label)}</span>
          ${r.sub ? `<span class="search-row-sub">${escapeHTML(r.sub)}</span>` : ''}
        </span>
      </button>
    `);

    resultsEl.innerHTML = rowsHTML.join('');

    // Default the top result to active so a bare Enter (no arrow keys)
    // acts on the best match — previously activeIndex started at -1 and
    // Enter silently did nothing until you pressed a arrow key first.
    activeIndex = 0;
    const rows = resultsEl.querySelectorAll('.search-row');
    rows.forEach((row, i) => {
      row.classList.toggle('search-row--active', i === 0);
      row.addEventListener('click', () => activateRow(row, tracks));
    });
  }

  function activateRow(row, tracks) {
    // Hide the overlay first, then act — previously close() ran after
    // navigation/playback was already kicked off, so the overlay's
    // normal 0.2s fade-out visibly overlapped with the view swapping
    // underneath it. closeInstant() drops it immediately with no
    // transition, which reads as "selected & gone" instead of lingering.
    closeInstant();

    const type = row.dataset.type;
    if (type === 'track') {
      const t = tracks.find((tr) => tr.filePath === row.dataset.trackPath);
      if (t && window.MusikPlayerUI) window.MusikPlayerUI.loadTrack(t);
    } else if (type === 'playlist') {
      location.hash = `#/library/${encodeURIComponent(row.dataset.playlistId)}`;
    } else if (type === 'artist' || type === 'album') {
      // No dedicated artist/album detail route exists yet — land on
      // Library for now. Swap this for a real filtered route once one
      // exists rather than leaving it silently wrong.
      location.hash = `#/library`;
    }
  }

  function handleKeydown(e) {
    const rows = Array.from(resultsEl.querySelectorAll('.search-row'));
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
      if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].click();
    } else if (e.key === 'Escape') {
      close();
    }
  }

  function focusRow(rows) {
    rows.forEach((r, i) => r.classList.toggle('search-row--active', i === activeIndex));
    rows[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  // Single opening animation regardless of entry point (click or
  // Ctrl/Cmd+K) — both paths call this same function. If opts.originRect
  // is given (the clicked trigger's getBoundingClientRect()), the overlay
  // grows out of that spot instead of just scaling from its own center —
  // see setMorphOrigin below.
  function open(opts = {}) {
    buildOverlay();
    lastTrigger = opts.trigger || null;
    isOpen = true;
    document.body.classList.add('search-open');
    inputEl.value = '';
    resultsEl.innerHTML = `<div class="search-empty-hint">Start typing to search your library…</div>`;

    if (opts.originRect) setMorphOrigin(opts.originRect);
    else overlayEl.style.removeProperty('transform-origin');

    requestAnimationFrame(() => {
      backdropEl.classList.add('search-backdrop--visible');
      overlayEl.classList.add('search-overlay--visible');
    });
    setTimeout(() => inputEl.focus(), 60);
  }

  // Computes where the trigger sits relative to the overlay's own resting
  // box, expressed as transform-origin percentages, so the scale-in
  // animation visibly grows out of the trigger instead of always
  // expanding from dead-center. Measures the overlay's resting position by
  // briefly removing its transform (so getBoundingClientRect reflects the
  // final layout box, not the pre-open scaled-down state).
  function setMorphOrigin(triggerRect) {
    const prevTransition = overlayEl.style.transition;
    overlayEl.style.transition = 'none';
    overlayEl.style.transform = 'translate(-50%, 0) scale(1)';
    const restRect = overlayEl.getBoundingClientRect();
    overlayEl.style.transform = '';
    overlayEl.style.transition = prevTransition;
    void overlayEl.offsetWidth; // flush before re-enabling transition

    const originX = ((triggerRect.left + triggerRect.width / 2 - restRect.left) / restRect.width) * 100;
    const originY = ((triggerRect.top + triggerRect.height / 2 - restRect.top) / restRect.height) * 100;
    overlayEl.style.transformOrigin = `${originX}% ${originY}%`;
  }

  // A separate fixed element that actually travels from the topbar bar's
  // screen rect to the overlay's resting rect, growing and fading along
  // the way. setMorphOrigin (above) only fakes "grows from that spot" via
  // transform-origin on the overlay itself; this makes the bar visibly
  // move, not just the overlay appearing near where it was clicked.
  function playMorphGhost(startRect) {
    const ghost = document.createElement('div');
    ghost.className = 'search-morph-ghost';
    ghost.style.left = `${startRect.left}px`;
    ghost.style.top = `${startRect.top}px`;
    ghost.style.width = `${startRect.width}px`;
    ghost.style.height = `${startRect.height}px`;
    document.body.appendChild(ghost);

    const targetWidth = Math.min(660, window.innerWidth * 0.9);
    const targetLeft = (window.innerWidth - targetWidth) / 2;
    const targetTop = window.innerHeight * 0.15;
    const targetHeight = 58; // matches .search-input-row's rough height

    requestAnimationFrame(() => {
      ghost.style.transition =
        'left 0.22s var(--ease-out), top 0.22s var(--ease-out), ' +
        'width 0.22s var(--ease-out), height 0.22s var(--ease-out), ' +
        'border-radius 0.22s var(--ease-out), opacity 0.16s var(--ease-out) 0.1s';
      ghost.style.left = `${targetLeft}px`;
      ghost.style.top = `${targetTop}px`;
      ghost.style.width = `${targetWidth}px`;
      ghost.style.height = `${targetHeight}px`;
      ghost.style.borderRadius = '20px';
      ghost.style.opacity = '0';
    });

    setTimeout(() => ghost.remove(), 280);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    backdropEl.classList.remove('search-backdrop--visible');
    overlayEl.classList.remove('search-overlay--visible');
    document.body.classList.remove('search-open');

    // Tiny settle bounce on the page underneath, cleared after it plays.
    document.body.classList.add('search-closing-settle');
    setTimeout(() => document.body.classList.remove('search-closing-settle'), 260);

    lastTrigger?.focus?.();
  }

  // Same end state as close(), but skips the fade — used when a result
  // was just activated and we're about to navigate/play, where a lingering
  // 200ms fade reads as "laggy" rather than "responsive".
  function closeInstant() {
    if (!isOpen) return;
    isOpen = false;
    overlayEl.classList.add('search-overlay--no-transition');
    backdropEl.classList.add('search-overlay--no-transition');
    backdropEl.classList.remove('search-backdrop--visible');
    overlayEl.classList.remove('search-overlay--visible');
    document.body.classList.remove('search-open');
    // Force reflow so the no-transition class actually applies before
    // we remove it on the next frame, instead of the change getting
    // batched together with the class removal below.
    void overlayEl.offsetWidth;
    requestAnimationFrame(() => {
      overlayEl.classList.remove('search-overlay--no-transition');
      backdropEl.classList.remove('search-overlay--no-transition');
    });
  }

  // Global shortcut — works from any view, any route. Gives the sidebar
  // trigger the same brief "listening" ring a click's scale-punch gives
  // it, so keyboard-only users get equivalent tactile confirmation.
  document.addEventListener('keydown', (e) => {
    const isK = e.key === 'k' || e.key === 'K';
    if (!(e.ctrlKey || e.metaKey) || !isK) return;
    e.preventDefault();

    if (isOpen) {
      close();
      return;
    }
    const trigger = document.querySelector('.nav-link--action[data-action="open-search"]');
    trigger?.classList.add('search-trigger-listening');
    setTimeout(() => trigger?.classList.remove('search-trigger-listening'), 260);
    open({ trigger, originRect: trigger?.getBoundingClientRect() });
  });

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(str) {
    return escapeHTML(str);
  }

  // ── Persistent topbar search bar ─────────────────────────────────
  // Lives outside #main entirely (appended straight to document.body,
  // same reasoning as the overlay itself) — so it's unaffected by
  // app.js's per-route innerHTML swap and shows up identically on every
  // tab without needing to be added to each view's own markup. Clicking
  // it opens the same overlay everything else opens, with a morph
  // transition seeded from this bar's own position (see setMorphOrigin).
  //
  // POSITIONING NOTE: pinned to `left: var(--sidebar-width-collapsed)`
  // since that's the only sidebar-width variable visible from this file.
  // I don't have index.html/layouts.css to confirm exactly how #main is
  // offset in every layout mode (dynamic/pinned/topbar) — if this doesn't
  // line up pixel-perfect against the real content area in some mode,
  // send those files and I'll match it exactly instead of guessing.
  function injectTopbarTrigger() {
    if (document.getElementById('global-search-bar')) return;

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.id = 'global-search-bar';
    bar.className = 'global-search-bar';
    bar.innerHTML = `
      <svg class="global-search-bar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span class="global-search-bar-placeholder">What do you want to play?</span>
      <kbd class="global-search-bar-hint">CTRL K</kbd>
    `;
    document.body.appendChild(bar);

    bar.addEventListener('click', () => {
      const rect = bar.getBoundingClientRect();
      // Bar fades out in place (CSS handoff class) while the ghost below
      // does the actual traveling — was previously animating the bar's
      // own transform too *and* passing originRect into open() (which
      // scales the overlay in from that same point), so three things
      // moved away from the same spot at once. Ghost only, now.
      bar.classList.add('global-search-bar--handoff');
      setTimeout(() => bar.classList.remove('global-search-bar--handoff'), 160);
      playMorphGhost(rect);
      open({ trigger: bar });
    });
  }

  if (document.body) injectTopbarTrigger();
  else document.addEventListener('DOMContentLoaded', injectTopbarTrigger);

  return { open, close };
})();
