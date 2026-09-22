// src/ui/queue-panel.js
//
// Slide-out "Up Next" queue drawer, opened from a toggle button in the
// player bar (see player-bar.js). Mirrors the common pattern across
// Spotify/Apple Music/YouTube Music: right-side panel, current track
// pinned/highlighted at top of the visible list, drag-to-reorder, hover-
// reveal remove button, click a row to jump straight to it.
//
// Talks only through window.Musik.queue.* (IPC) and window.MusikPlayerUI —
// no direct access to queue-manager.js internals. Refreshes on the
// 'queueupdate' event (composition changed: add/remove/clear/reorder/
// playQueue) and re-highlights on 'trackupdate' (which track is current
// changed, e.g. via next()/previous()) without doing a full re-fetch.

(function () {
  let panelEl = null;
  let listEl = null;
  let isOpen = false;
  let dragFromIndex = null;
  let refreshSeq = 0;

  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function artSrc(track) {
    if (!track?.artData?.base64) return null;
    return `data:image/${track.artData.format || 'jpeg'};base64,${track.artData.base64}`;
  }

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // events.emit() only reaches THIS window. The miniplayer is a separate
  // renderer, so it never heard about queue edits made here. events.push()
  // round-trips through main.js, which fans the event out to every window
  // (this one included), so all queue views stay in sync.
  function notifyQueueChanged() {
    const ev = window.Musik?.events;
    if (ev?.push) ev.push('queueupdate');
    else ev?.emit('queueupdate');
  }

  function rowHTML(track, index, isCurrent) {
    const art = artSrc(track);
    return `
      <div class="q-row ${isCurrent ? 'q-row--active' : ''}" data-index="${index}" data-file-path="${escapeHTML(track.filePath)}" draggable="true">
        <span class="q-drag-handle" title="Drag to reorder">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="8" cy="6" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="8" cy="18" r="1.4"/><circle cx="16" cy="6" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="16" cy="18" r="1.4"/></svg>
        </span>
        ${art
          ? `<img class="q-art" src="${art}" alt="" loading="lazy" decoding="async">`
          : `<div class="q-art q-art--placeholder"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></div>`}
        <div class="q-row-info">
          <span class="q-row-title">${escapeHTML(track.title)}</span>
          <span class="q-row-artist">${escapeHTML(track.artist)}</span>
        </div>
        <span class="eq-bars ${isCurrent ? '' : 'q-hidden'}"><span class="eq-bar eq-bar--1"></span><span class="eq-bar eq-bar--2"></span><span class="eq-bar eq-bar--3"></span></span>
        <span class="q-row-time ${isCurrent ? 'q-hidden' : ''}">${fmtTime(track.duration)}</span>
        <button class="q-row-remove" data-action="remove" title="Remove from queue">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    `;
  }

  async function refresh() {
    if (!listEl) return;

    // refresh() is async and gets called from several places (queueupdate
    // fires from both the manager and the manual emits below). Without
    // this, two overlapping calls can resolve out of order and paint the
    // older queue over the newer one.
    const seq = ++refreshSeq;
    const queue = (await window.Musik.queue.getQueue()) ?? [];
    if (seq !== refreshSeq) return;
    const current = window.MusikPlayerUI?.getCurrentTrackData?.();
    const prevScroll = listEl.scrollTop;

    if (!queue.length) {
      listEl.innerHTML = `
        <div class="q-empty">
          <svg viewBox="0 0 24 24" width="28" height="28"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
          <span>Queue is empty</span>
        </div>
      `;
      return;
    }

    listEl.innerHTML = queue
      .map((t) => rowHTML(t, t.queueIndex, isCurrentRow(t, current)))
      .join('');
    listEl.scrollTop = prevScroll;

    wireRows(queue);
  }

  function scrollCurrentIntoView() {
    listEl?.querySelector('.q-row--active')?.scrollIntoView({ block: 'center' });
  }

  // The manager marks which queue slot is current (t.isCurrent), which is
  // what tells two copies of the same file apart. The player check on top
  // keeps a not-yet-played "current" slot (fresh queue, or the playing track
  // was just removed) from lighting up. `?? true` = older manager, no flag.
  function isCurrentRow(t, current) {
    return !!current && t.filePath === current.filePath && (t.isCurrent ?? true);
  }

  // Only swaps the active-row class + eq bars, no full re-render — called
  // on every 'trackupdate' (which fires far more often than 'queueupdate').
  function highlightCurrent() {
    if (!listEl) return;
    const current = window.MusikPlayerUI?.getCurrentTrackData?.();
    // Same file queued twice: filePath can't say which row is playing, so
    // re-fetch and let the manager's isCurrent decide (rare, so the cost is fine).
    if (current && listEl.querySelectorAll(`.q-row[data-file-path="${CSS.escape(current.filePath)}"]`).length > 1) {
      refresh();
      return;
    }
    listEl.querySelectorAll('.q-row').forEach((row) => {
      const isCurrent = !!current && row.dataset.filePath === current.filePath;
      row.classList.toggle('q-row--active', isCurrent);
      row.querySelector('.eq-bars')?.classList.toggle('q-hidden', !isCurrent);
      row.querySelector('.q-row-time')?.classList.toggle('q-hidden', isCurrent);
    });
  }

  function wireRows(queue) {
    listEl.querySelectorAll('.q-row').forEach((row, pos) => {
      const track = queue[pos];
      if (!track) return;
      const index = track.queueIndex;

      if (track) window.MusikContextMenu?.attachTrack?.(row, track);

      row.addEventListener('click', async (e) => {
        if (e.target.closest('[data-action="remove"]')) return;
        const track = await window.Musik.queue.jumpTo(index);
        if (track && window.MusikPlayerUI) await window.MusikPlayerUI.loadTrack(track);
        highlightCurrent();
      });

      row.querySelector('[data-action="remove"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.Musik.queue.remove(index);
        notifyQueueChanged();
      });

      row.addEventListener('dragstart', (e) => {
        dragFromIndex = index;
        row.classList.add('q-row--dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      row.addEventListener('dragend', () => {
        row.classList.remove('q-row--dragging');
        dragFromIndex = null;
        listEl.querySelectorAll('.q-row--drag-over').forEach((r) => r.classList.remove('q-row--drag-over'));
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragFromIndex === null || dragFromIndex === index) return;
        row.classList.add('q-row--drag-over');
      });

      row.addEventListener('dragleave', (e) => {
        // dragleave also fires when the cursor moves onto a child (art,
        // title, buttons) — only clear when actually leaving the row.
        if (row.contains(e.relatedTarget)) return;
        row.classList.remove('q-row--drag-over');
      });

      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('q-row--drag-over');
        if (dragFromIndex === null || dragFromIndex === index) return;
        await window.Musik.queue.move(dragFromIndex, index);
        notifyQueueChanged();
      });
    });
  }

  function open() {
    if (!panelEl) init();
    if (!panelEl) return;
    isOpen = true;
    panelEl.classList.add('q-panel--open');
    refresh().then(scrollCurrentIntoView);
  }

  function close() {
    if (!panelEl) return;
    isOpen = false;
    panelEl.classList.remove('q-panel--open');
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function init() {
    const existing = document.getElementById('queue-panel');
    if (existing) {
      panelEl = existing;
      listEl = document.getElementById('q-panel-list');
      return;
    }

    panelEl = document.createElement('div');
    panelEl.id = 'queue-panel';
    panelEl.className = 'q-panel glass-surface--elevated';
    panelEl.innerHTML = `
      <div class="q-panel-header">
        <h3>Queue</h3>
        <button class="q-panel-clear" id="q-panel-clear" title="Clear queue">Clear</button>
        <button class="q-panel-close" id="q-panel-close" title="Close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="q-panel-list" id="q-panel-list"></div>
    `;
    document.body.appendChild(panelEl);

    listEl = document.getElementById('q-panel-list');

    document.getElementById('q-panel-close').addEventListener('click', close);
    document.getElementById('q-panel-clear').addEventListener('click', async () => {
      await window.Musik.queue.clear();
      notifyQueueChanged();
    });

    const ev = window.Musik?.events;
    if (!ev) console.warn('[queue-panel] window.Musik.events missing — panel will not live-update');
    ev?.on('queueupdate', () => { if (isOpen) refresh(); });
    ev?.on('trackupdate', () => { if (isOpen) highlightCurrent(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  window.MusikQueuePanel = { open, close, toggle };
})();
