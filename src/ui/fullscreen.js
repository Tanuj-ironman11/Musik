// src/ui/fullscreen.js — Now Playing overlay DOM and simple controls.
// Keeps OS fullscreen separate; this file only manages the in-app overlay.

(function () {
  let root = null;
  let isOpen = false;
  let rafId = null;

  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function kick(btn) {
    btn.classList.remove('npf-icon-kick');
    void btn.offsetWidth;
    btn.classList.add('npf-icon-kick');
  }

  function build() {
    root = document.createElement('div');
    root.id = 'now-playing-fullscreen';
    root.innerHTML = `
      <div id="npf-bg-art"></div>

      <div class="npf-topbar">
        <span class="npf-topbar-spacer"></span>
        <span class="npf-topbar-title">Now Playing</span>
        <button id="npf-lyrics-toggle" class="npf-topbar-btn" title="Lyrics">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
        <button id="npf-close" class="npf-topbar-btn" title="Close (Esc)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="npf-layout">
        <div id="npf-media-area">
          <div id="npf-art-wrap">
            <div id="npf-art" class="pb-art--placeholder">
              <svg class="placeholder-note-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
            </div>
          </div>
        </div>

        <div class="npf-info">
          <div id="npf-meta">
            <p id="npf-title" class="marquee">Nothing playing</p>
            <p id="npf-artist" class="marquee"></p>
          </div>

          <div id="npf-lyrics-panel">
            <div id="npf-lyrics-toolbar">
              <button id="npf-lyrics-translit" class="npf-lyrics-chip" title="Toggle romanization" hidden>Aa</button>
              <button id="npf-lyrics-edit" class="npf-lyrics-chip" title="Edit lyrics">Edit</button>
            </div>
            <div id="npf-lyrics-scroll">
              <p id="npf-lyrics-status" class="npf-lyrics-status">Loading lyrics…</p>
            </div>
            <div id="npf-lyrics-editor" hidden>
              <textarea id="npf-lyrics-textarea" placeholder="Paste or type lyrics here. Plain text, or LRC format (e.g. [00:12.34] line) for synced playback."></textarea>
              <div id="npf-lyrics-editor-actions">
                <button id="npf-lyrics-clear" class="npf-lyrics-chip npf-lyrics-chip--ghost">Clear override</button>
                <div class="npf-lyrics-editor-spacer"></div>
                <button id="npf-lyrics-cancel" class="npf-lyrics-chip npf-lyrics-chip--ghost">Cancel</button>
                <button id="npf-lyrics-save" class="npf-lyrics-chip npf-lyrics-chip--accent">Save</button>
              </div>
            </div>
          </div>
        </div>

        <div id="npf-transport">
          <div id="npf-progress-row">
            <span id="npf-time-current" class="npf-time">0:00</span>
            <input type="range" id="npf-progress" min="0" max="100" step="0.1" value="0" />
            <span id="npf-time-duration" class="npf-time">0:00</span>
          </div>
          <div id="npf-controls">
            <button id="npf-prev" class="npf-btn" title="Previous">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linejoin="round">
                <rect x="5.5" y="5" width="2.4" height="14" rx="1.2"/>
                <path d="M18.5 6.3v11.4a1 1 0 01-1.53.85l-8.6-5.7a1 1 0 010-1.7l8.6-5.7a1 1 0 011.53.85z" stroke-linecap="round"/>
              </svg>
            </button>
            <button id="npf-play-pause" class="npf-play-btn" title="Play">
              <svg class="npf-icon-play" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" stroke-linecap="round" width="24" height="24">
                <path d="M8.5 5.6a1 1 0 011.53-.85l9 6.4a1 1 0 010 1.7l-9 6.4A1 1 0 018.5 18.4z"/>
              </svg>
              <svg class="npf-icon-pause" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <rect x="6.3" y="5" width="3.6" height="14" rx="1.6"/>
                <rect x="14.1" y="5" width="3.6" height="14" rx="1.6"/>
              </svg>
            </button>
            <button id="npf-next" class="npf-btn" title="Next">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linejoin="round">
                <rect x="16.1" y="5" width="2.4" height="14" rx="1.2"/>
                <path d="M5.5 6.3v11.4a1 1 0 001.53.85l8.6-5.7a1 1 0 000-1.7l-8.6-5.7a1 1 0 00-1.53.85z" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector('#npf-close').addEventListener('click', close);
    root.querySelector('#npf-art-wrap').addEventListener('dblclick', close);

    root.querySelector('#npf-lyrics-toggle').addEventListener('click', toggleLyricsPanel);
    root.querySelector('#npf-lyrics-translit').addEventListener('click', toggleRomanization);
    root.querySelector('#npf-lyrics-edit').addEventListener('click', enterEditMode);
    root.querySelector('#npf-lyrics-cancel').addEventListener('click', exitEditMode);
    root.querySelector('#npf-lyrics-save').addEventListener('click', saveManualLyrics);
    root.querySelector('#npf-lyrics-clear').addEventListener('click', clearManualLyrics);

    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('npf-dragover');
    });
    root.addEventListener('dragleave', (e) => {
      if (e.target === root) root.classList.remove('npf-dragover');
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('npf-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleLyricFileDrop(file);
    });

    root.querySelector('#npf-prev').addEventListener('click', (e) => {
      kick(e.currentTarget);
      window.MusikPlayerUI?.previous();
    });
    root.querySelector('#npf-next').addEventListener('click', (e) => {
      kick(e.currentTarget);
      window.MusikPlayerUI?.next();
    });
    root.querySelector('#npf-play-pause').addEventListener('click', () => {
      window.MusikPlayerUI?.togglePlayPause();
    });

    const progress = root.querySelector('#npf-progress');
    let scrubbing = false;
    progress.addEventListener('mousedown', () => { scrubbing = true; });
    progress.addEventListener('input', () => {
      const pct = progress.max > 0 ? (progress.value / progress.max) * 100 : 0;
      progress.style.setProperty('--progress', `${pct}%`);
      root.querySelector('#npf-time-current').textContent = fmtTime(Number(progress.value));
    });
    progress.addEventListener('change', () => {
      window.MusikPlayerUI?.seek(Number(progress.value));
      scrubbing = false;
    });
    progress._scrubbing = () => scrubbing;
  }

  function updateMeta(track) {
    if (!root) return;
    root.querySelector('#npf-title').textContent = track?.title ?? 'Unknown Title';
    root.querySelector('#npf-artist').textContent = track?.artist ?? 'Unknown Artist';
    // attach(), not refresh() — refresh() alone won't re-register the
    // ResizeObserver if these were detach()'d while the overlay was
    // closed (see close() below). attach() is a safe superset: it just
    // calls refresh() if already bound, or does full setup if not.
    window.MusikMarquee?.attach(root.querySelector('#npf-title'));
    window.MusikMarquee?.attach(root.querySelector('#npf-artist'));
    loadLyrics(track);
  }

  let lyricsState = null;
  let lyricsTrackRef = null;
  let lyricsLoadToken = 0;

  function toggleLyricsPanel() {
    root?.querySelector('.npf-info')?.classList.toggle('npf-info--lyrics-open');
    root?.querySelector('#npf-lyrics-toggle')?.classList.toggle('is-active');
  }

  async function loadLyrics(track) {
    if (!root) return;
    lyricsTrackRef = track || null;
    const scroll = root.querySelector('#npf-lyrics-scroll');
    const translitBtn = root.querySelector('#npf-lyrics-translit');
    const token = ++lyricsLoadToken;

    lyricsState = null;
    translitBtn.hidden = true;
    scroll.innerHTML = `<p class="npf-lyrics-status">Loading lyrics…</p>`;

    if (!track?.title) {
      scroll.innerHTML = `<p class="npf-lyrics-status">Nothing playing.</p>`;
      return;
    }
    if (!window.Musik?.lyrics?.get) {
      scroll.innerHTML = `<p class="npf-lyrics-status">Lyrics module not wired up yet.</p>`;
      return;
    }

    try {
      const result = await window.Musik.lyrics.get({
        artist: track.artist, title: track.title, album: track.album, duration: track.duration,
      });
      if (token !== lyricsLoadToken) return;

      lyricsState = { ...result, showRomanized: false };

      if (result.synced && window.Musik?.lyrics?.romanizeLines) {
        const romanized = await window.Musik.lyrics.romanizeLines(result.synced);
        if (token !== lyricsLoadToken) return;
        if (romanized) {
          lyricsState.synced = romanized;
          translitBtn.hidden = false;
        }
      }

      renderLyrics();
    } catch (err) {
      if (token !== lyricsLoadToken) return;
      lyricsState = { source: 'error', synced: null, plain: null };
      scroll.innerHTML = `<p class="npf-lyrics-status">Couldn't load lyrics. <button id="npf-lyrics-retry" class="npf-lyrics-chip">Retry</button></p>`;
      scroll.querySelector('#npf-lyrics-retry')?.addEventListener('click', () => loadLyrics(track));
    }
  }

  function wordsForLine(words, synced, i) {
    const startMs = synced[i].time * 1000;
    const endMs = i + 1 < synced.length ? synced[i + 1].time * 1000 : Infinity;
    // small tolerance for float round-trip through seconds<->ms
    return words.filter((w) => w.startMs >= startMs - 25 && w.startMs < endMs - 25);
  }

  function renderLyrics() {
    const scroll = root?.querySelector('#npf-lyrics-scroll');
    if (!scroll || !lyricsState) return;

    if (lyricsState.synced?.length) {
      const words = lyricsState.words;
      scroll.innerHTML = lyricsState.synced.map((line, i) => {
        const text = lyricsState.showRomanized && line.romanized ? line.romanized : line.text;
        const lineWords = words && !lyricsState.showRomanized ? wordsForLine(words, lyricsState.synced, i) : null;
        const inner = lineWords?.length
          ? lineWords.map((w) => `<span class="npf-lyric-word" data-start="${w.startMs}" data-end="${w.endMs}">${escapeHtml(w.text)}</span>`).join(' ')
          : escapeHtml(text);
        return `<p class="npf-lyric-line" data-index="${i}" data-time="${line.time}">${inner}</p>`;
      }).join('');
    } else if (lyricsState.plain) {
      const cls = lyricsState.source === 'manual' ? '' : ' npf-lyric-unsynced';
      scroll.innerHTML = `<p class="npf-lyric-plain${cls}">${escapeHtml(lyricsState.plain).replace(/\n/g, '<br>')}</p>`;
    } else {
      scroll.innerHTML = `<p class="npf-lyrics-status">No lyrics found. Add them yourself?</p>`;
    }
  }

  function toggleRomanization() {
    if (!lyricsState?.synced) return;
    lyricsState.showRomanized = !lyricsState.showRomanized;
    root?.querySelector('#npf-lyrics-translit')?.classList.toggle('active', lyricsState.showRomanized);
    renderLyrics();
  }

  let lastActiveLyricIndex = -1;
  function updateActiveWord(lineEl, timeMs) {
    const wordEls = lineEl.querySelectorAll('.npf-lyric-word');
    for (const el of wordEls) {
      const start = Number(el.dataset.start);
      const end = Number(el.dataset.end);

      if (timeMs >= end) {
        // already sung — solid, no partial fill needed
        el.classList.add('npf-lyric-word--sung');
        el.classList.remove('npf-lyric-word--active');
      } else if (timeMs >= start) {
        // currently being sung — sweep the fill left to right across its duration
        const dur = Math.max(end - start, 1);
        const pct = Math.max(0, Math.min(1, (timeMs - start) / dur)) * 100;
        el.classList.remove('npf-lyric-word--sung');
        el.classList.add('npf-lyric-word--active');
        el.style.setProperty('--word-fill', `${pct}%`);
      } else {
        // not reached yet — stays dim
        el.classList.remove('npf-lyric-word--sung', 'npf-lyric-word--active');
      }
    }
  }

  function updateActiveLyricLine(currentTime) {
    if (!lyricsState?.synced?.length) return;
    const scroll = root?.querySelector('#npf-lyrics-scroll');
    if (!scroll || scroll.querySelector('#npf-lyrics-editor') || !root.querySelector('.npf-info--lyrics-open')) return;

    let idx = -1;
    for (let i = 0; i < lyricsState.synced.length; i++) {
      if (lyricsState.synced[i].time <= currentTime) idx = i;
      else break;
    }
    if (idx !== lastActiveLyricIndex) {
      lastActiveLyricIndex = idx;

      const prevActive = scroll.querySelector('.npf-lyric-active');
      prevActive?.classList.remove('npf-lyric-active');
      if (idx >= 0) {
        const el = scroll.querySelector(`.npf-lyric-line[data-index="${idx}"]`);
        el?.classList.add('npf-lyric-active');
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    if (lyricsState.words?.length && idx >= 0) {
      const activeLineEl = scroll.querySelector(`.npf-lyric-line[data-index="${idx}"]`);
      if (activeLineEl) updateActiveWord(activeLineEl, currentTime * 1000);
    }
  }

  function enterEditMode() {
    const editor = root?.querySelector('#npf-lyrics-editor');
    const textarea = root?.querySelector('#npf-lyrics-textarea');
    if (!editor || !textarea) return;

    if (lyricsState?.source === 'manual') {
      textarea.value = lyricsState.plain || (lyricsState.synced || []).map((l) => l.text).join('\n');
    } else if (lyricsState?.plain) {
      textarea.value = lyricsState.plain;
    } else {
      textarea.value = '';
    }

    root.querySelector('.npf-info')?.classList.add('npf-info--lyrics-open');
    editor.hidden = false;
    textarea.focus();
  }

  function exitEditMode() {
    const editor = root?.querySelector('#npf-lyrics-editor');
    if (editor) editor.hidden = true;
  }

  async function saveManualLyrics() {
    if (!lyricsTrackRef?.title || !window.Musik?.lyrics?.saveManual) return;
    const textarea = root?.querySelector('#npf-lyrics-textarea');
    const raw = textarea?.value ?? '';
    const looksLikeLrc = /^\[\d{1,2}:\d{2}/m.test(raw);

    const saved = await window.Musik.lyrics.saveManual(
      { artist: lyricsTrackRef.artist, title: lyricsTrackRef.title, album: lyricsTrackRef.album },
      looksLikeLrc ? { plain: null, synced: raw } : { plain: raw, synced: null }
    );
    lyricsState = { ...saved, showRomanized: false };
    exitEditMode();
    renderLyrics();
  }

  async function clearManualLyrics() {
    if (!lyricsTrackRef?.title || !window.Musik?.lyrics?.clearManual) return;
    await window.Musik.lyrics.clearManual({ artist: lyricsTrackRef.artist, title: lyricsTrackRef.title, album: lyricsTrackRef.album });
    exitEditMode();
    loadLyrics(lyricsTrackRef);
  }

  // ---------------------------------------------------------------------
  // Drag-and-drop lyric file import — drop a rich sync JSON (Apple-style
  // syllable export), a .lrc, or a plain .txt anywhere on the fullscreen
  // overlay and it saves as the manual override for whatever's playing.
  // Same conversion as scripts/import-richsync.js; no shared-module setup
  // between renderer and that Node CLI (no bundler), so mirror any change
  // to that script's logic here too.
  // ---------------------------------------------------------------------

  function convertRichSyncJson(raw) {
    const content = raw?.lyrics?.Content;
    if (!Array.isArray(content) || !content.length) return null;

    const words = [];
    const synced = [];
    const plainLines = [];

    for (const line of content) {
      const syllables = line?.Lead?.Syllables;
      if (!Array.isArray(syllables) || !syllables.length) continue;

      let lineText = '';
      for (const syl of syllables) {
        const text = (syl.Text || '').trim();
        if (!text) continue;

        if (syl.IsPartOfWord && words.length) {
          const prev = words[words.length - 1];
          prev.text += text;
          prev.endMs = syl.EndTime;
          lineText += text;
        } else {
          words.push({ text, startMs: syl.StartTime, endMs: syl.EndTime });
          lineText += (lineText ? ' ' : '') + text;
        }
      }

      if (lineText) {
        synced.push({ time: (line.Lead.StartTime ?? 0) / 1000, text: lineText });
        plainLines.push(lineText);
      }
    }

    if (!words.length) return null;
    return { plain: plainLines.join('\n') || null, synced: synced.length ? synced : null, words };
  }

  async function handleLyricFileDrop(file) {
    if (!lyricsTrackRef?.title || !window.Musik?.lyrics?.saveManual) return;
    const text = await file.text();

    let payload = null;
    try {
      const json = JSON.parse(text);
      payload = convertRichSyncJson(json);
      if (!payload && (json.plain || json.synced || json.words)) {
        // already Musik-shaped, e.g. a previously exported manual file
        payload = { plain: json.plain || null, synced: json.synced || null, words: json.words || null };
      }
    } catch (_) {
      // not JSON — fall through to LRC/plain text handling below
    }

    if (!payload) {
      const looksLikeLrc = /^\[\d{1,2}:\d{2}/m.test(text);
      payload = looksLikeLrc ? { plain: null, synced: text } : { plain: text, synced: null };
    }

    const saved = await window.Musik.lyrics.saveManual(
      { artist: lyricsTrackRef.artist, title: lyricsTrackRef.title, album: lyricsTrackRef.album },
      payload
    );
    lyricsState = { ...saved, showRomanized: false };
    root.querySelector('.npf-info')?.classList.add('npf-info--lyrics-open');
    renderLyrics();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateArt(artData) {
    if (!root) return;
    const art = root.querySelector('#npf-art');
    const bg = root.querySelector('#npf-bg-art');
    if (artData?.base64 && artData?.format) {
      const url = `data:${artData.format};base64,${artData.base64}`;
      art.classList.remove('pb-art--placeholder');
      art.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
      bg.style.backgroundImage = `url(${url})`;
    } else {
      art.classList.add('pb-art--placeholder');
      art.innerHTML = `<svg class="placeholder-note-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;
      bg.style.backgroundImage = '';
    }
  }

  function setPlayIcon(isPlaying) {
    root?.querySelector('#npf-play-pause')?.classList.toggle('is-playing', isPlaying);
  }

  function tick() {
    if (!isOpen || !root) return;
    const cur = window.MusikPlayerUI?.getCurrentTime() ?? 0;
    const dur = window.MusikPlayerUI?.getDuration() ?? 0;
    const progress = root.querySelector('#npf-progress');
    progress.max = dur || 0;
    if (!progress._scrubbing?.()) {
      progress.value = cur;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      progress.style.setProperty('--progress', `${pct}%`);
      root.querySelector('#npf-time-current').textContent = fmtTime(cur);
    }
    root.querySelector('#npf-time-duration').textContent = fmtTime(dur);
    updateActiveLyricLine(cur);
    rafId = requestAnimationFrame(tick);
  }

  function getAnimMediumMs() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--anim-medium').trim();
    const ms = parseFloat(raw);
    return isFinite(ms) ? ms : 240;
  }

  let closeTimer = null;

  function getExitDurationMs() {
    const raw = getComputedStyle(root).getPropertyValue('--npf-exit-dur').trim();
    const ms = parseFloat(raw);
    return isFinite(ms) ? ms : 220;
  }

  function open() {
    if (!root) build();
    clearTimeout(closeTimer);
    root.classList.remove('is-closing');
    isOpen = true;
    document.body.classList.add('npf-open');
    // ensure visualizer topbar controls are present in the fullscreen topbar
    try { window.MusikVisualizer?.ensureControls?.(); } catch (e) {}

    const track = window.MusikPlayerUI?.getCurrentTrackData?.();
    updateMeta(track);
    setPlayIcon(!(window.MusikPlayerUI?.isPaused?.() ?? true));
    if (track?.artData) updateArt(track.artData);

    requestAnimationFrame(() => root.classList.add('is-open'));

    rafId = requestAnimationFrame(tick);
  }

  function close() {
    isOpen = false;
    root?.classList.add('is-closing');
    root?.classList.remove('is-open');
    document.body.classList.remove('npf-open');
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;

    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      root?.classList.remove('is-closing');
      // The overlay stays in the DOM (just opacity:0) after closing, so
      // without this the title/artist marquee — driven by the Web
      // Animations API in marquee.js, not CSS — just keeps scrolling
      // invisibly in the background forever. Wait until the exit fade
      // is actually done (not on click) so nothing snaps mid-fade.
      // updateMeta() re-attach()es on the next open().
      window.MusikMarquee?.detach(root?.querySelector('#npf-title'));
      window.MusikMarquee?.detach(root?.querySelector('#npf-artist'));
    }, root ? getExitDurationMs() : getAnimMediumMs());
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  window.Musik?.events?.on('trackupdate', updateMeta);
  window.Musik?.events?.on('artupdate', updateArt);
  window.Musik?.events?.on('play', () => setPlayIcon(true));
  window.Musik?.events?.on('pause', () => setPlayIcon(false));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) { close(); return; }

    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    if (!typing && e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggle();
    }
  });

  window.MusikNowPlayingFullscreen = { open, close, toggle, isOpen: () => isOpen };

  // OS-level fullscreen (unrelated to the overlay above) — F11 toggles the real window.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      window.Musik?.window?.toggleFullscreen?.();
    }
  });

  window.Musik?.events?.on('fullscreenchange', ({ fullscreen }) => {
    document.body.classList.toggle('is-os-fullscreen', !!fullscreen);
  });

  window.Musik?.window?.isFullscreen?.().then((fs) => {
    document.body.classList.toggle('is-os-fullscreen', !!fs);
  }).catch(() => {});
})();
