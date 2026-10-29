// src/ui/context-menu.js
// Shared right-click menus for track rows and playlist cards. Views wire them with:
//   window.MusikContextMenu.attachTrack(rowEl, track, opts)
//   window.MusikContextMenu.attachPlaylist(cardEl, playlist, opts)
//   window.MusikContextMenu.actions: the same actions without a menu (search panel)
// opts (all optional):
//   onChange   called after an action changed library data (track removed,
//              playlist deleted or renamed) so the owning view can re-render.
//   playlistId attachTrack only: the playlist the row is shown in. Adds
//              "Remove from Playlist".
//   queueIndex attachTrack only: the row's queue index (queue panel). Add to
//              Queue becomes "Remove from Queue", Play Next moves the existing
//              slot, Play jumps within the queue.
//   compact    attachTrack only: small-window menu (miniplayer) with a short item
//              set; "Add to Playlist" opens in place with a Back row. Pair with
//              queueIndex.
//   onPlay     attachTrack + compact only: replaces Play (the miniplayer sends a
//              command instead).
// Add to Playlist lists playlist names in one flat menu, no nested submenu.

(function () {
  let openMenuEl = null;

  function closeMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
    document.removeEventListener('mousedown', onOutsideClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('scroll', closeMenu, true);
  }

  function onOutsideClick(e) {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { closeMenu(); return; }
    if (!openMenuEl) return;
    const items = [...openMenuEl.querySelectorAll('.ctx-menu-item')];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'ArrowLeft') { openMenuEl.querySelector('[data-back]')?.click(); return; }
    else if (e.key === 'ArrowRight' && document.activeElement?.matches?.('[data-open-playlists]')) {
      document.activeElement.click();
      return;
    }
    if (next) { e.preventDefault(); next.focus(); }
  }

  function clampToViewport(x, y, width, height) {
    const maxX = window.innerWidth - width - 8;
    const maxY = window.innerHeight - height - 8;
    return { x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) };
  }

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(str) { return escapeHTML(str); }

  // Appends the menu, clamps it into the viewport, and wires the shared
  // close-on-outside-click / Escape / scroll listeners.
  function mountMenu(menu, x, y) {
    document.body.appendChild(menu);
    openMenuEl = menu;

    const rect = menu.getBoundingClientRect();
    const { x: cx, y: cy } = clampToViewport(x, y, rect.width, rect.height);
    menu.style.left = `${cx}px`;
    menu.style.top = `${cy}px`;

    // Deferred so the contextmenu event that opened this menu doesn't
    // immediately register as the "outside click" that closes it.
    setTimeout(() => {
      document.addEventListener('mousedown', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('scroll', closeMenu, true);
    }, 0);
  }

  // Other queue views (miniplayer) only hear about edits made here if the
  // event round-trips through main, same as queue-panel's own notify.
  function notifyQueueChanged() {
    const ev = window.Musik?.events;
    if (ev?.push) ev.push('queueupdate');
    else ev?.emit?.('queueupdate');
  }

  // Appends to the queue; with playNext, moves the new track to sit right
  // after the current one. add() returns the queue in display order with
  // isCurrent/queueIndex set; the new track's queueIndex is always the last
  // slot. Works with shuffle on too: move() acts on the shuffle order there.
  async function enqueue(track, playNext) {
    const q = window.Musik?.queue;
    // Same fail-loud rule as Remove from Library: a missing bridge method
    // shouldn't look like a successful add.
    if (typeof q?.add !== 'function') {
      window.MusikDialog?.alert?.('Queue isn\'t available in this build.');
      return;
    }
    // loadTrack() never touches the queue, so a song played straight from
    // Home/Library isn't in it. add() onto an empty queue marks the new
    // track current, and next() then skips past it. Seed the playing track
    // first so the queue starts from what's actually playing.
    const playing = window.MusikPlayerUI?.getCurrentTrackData?.();
    if (playing && typeof q.getQueue === 'function' && !(await q.getQueue())?.length) {
      await q.add(playing);
    }
    const after = await q.add(track);
    if (playNext && Array.isArray(after) && typeof q.move === 'function') {
      const newIdx = after.length - 1;
      const cur = after.findIndex((t) => t.isCurrent);
      const target = cur > -1 ? after[cur + 1] : null;
      if (target && target.queueIndex !== newIdx) await q.move(newIdx, target.queueIndex);
    }
    notifyQueueChanged();
  }

  // In-queue "Play Next": moves an existing slot to sit right after the
  // current one. Positions are display order (shuffle-aware); move() takes
  // queue indices, so the target slot's queueIndex is looked up. A slot
  // before the current one shifts the current left when it's pulled out,
  // hence the from < cur case.
  async function moveNextInQueue(track, queueIndex) {
    const q = window.Musik?.queue;
    if (typeof q?.getQueue !== 'function' || typeof q.move !== 'function') {
      window.MusikDialog?.alert?.('Queue isn\'t available in this build.');
      return;
    }
    const live = (await q.getQueue()) ?? [];
    const from = live.findIndex((t) => t.queueIndex === queueIndex && t.filePath === track.filePath);
    const cur = live.findIndex((t) => t.isCurrent);
    if (from === -1 || cur === -1 || from === cur) return;
    const to = from < cur ? cur : cur + 1;
    if (to !== from) await q.move(queueIndex, live[to].queueIndex);
    notifyQueueChanged();
  }

  // Shared by the track/playlist menus below and the search actions panel
  // (exported as MusikContextMenu.actions).
  async function playTrack(track, queueIndex) {
    // From the queue, jump within it (same as clicking the row) so the
    // queue's current slot follows what's actually playing.
    const target = Number.isInteger(queueIndex)
      ? ((await window.Musik?.queue?.jumpTo?.(queueIndex)) ?? track)
      : track;
    if (window.MusikPlayerUI) await window.MusikPlayerUI.loadTrack(target);
  }

  function addToPlaylist(playlistId, track) {
    return window.Musik?.library?.addTrack?.(playlistId, track.filePath);
  }

  async function newPlaylistWith(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const name = await window.MusikDialog?.prompt?.('New playlist name:');
    if (name === null || name === undefined) return;
    const created = await window.Musik?.library?.createPlaylist?.(name);
    if (!created) return;
    for (const t of list) await window.Musik?.library?.addTrack?.(created.id, t.filePath);
  }

  // Session-only: broadcasts artupdate so the accent extractor and player bar
  // update live, but nothing is written to musik-library.json (there is no
  // library:update-art IPC channel yet).
  async function refreshArt(track) {
    let artData = await window.Musik?.art?.extract?.(track.filePath);
    if (!artData && track.artist && track.album) {
      artData = await window.Musik?.art?.fetchOnline?.({ artist: track.artist, album: track.album });
    }
    if (artData) {
      window.Musik?.events?.emit('artupdate', artData);
    } else {
      window.MusikDialog?.alert?.('No cover art found for this track.');
    }
  }

  // Reads the live library: the playlist object a view holds can be stale.
  async function playlistTracks(playlist) {
    const [allPlaylists, allTracks] = await Promise.all([
      window.Musik?.library?.getPlaylists?.(),
      window.Musik?.library?.getTracks?.(),
    ]);
    const fresh = (allPlaylists ?? []).find((p) => p.id === playlist.id) ?? playlist;
    return (fresh.trackIds || [])
      .map((id) => (allTracks ?? []).find((t) => t.filePath === id))
      .filter(Boolean);
  }

  async function playPlaylist(playlist) {
    const list = await playlistTracks(playlist);
    if (list.length && window.MusikPlayerUI) {
      window.MusikPlayerUI.playQueue?.(list) ?? window.MusikPlayerUI.loadTrack(list[0]);
    }
  }

  async function renamePlaylist(playlist, onChange) {
    const newName = await window.MusikDialog?.prompt?.('Rename playlist:', playlist.name);
    if (newName === null || newName === undefined) return;
    await window.Musik?.library?.renamePlaylist?.(playlist.id, newName);
    onChange?.();
  }

  // Deletes the playlist only; its tracks stay in the library.
  async function deletePlaylist(playlist, onChange) {
    const ok = await window.MusikDialog?.confirm?.(`Delete "${playlist.name}"?`, {
      detail: 'Its tracks stay in your library.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await window.Musik?.library?.deletePlaylist?.(playlist.id);
    onChange?.();
  }

  // Miniplayer-sized track menu. Separate from showTrackMenu on purpose: a
  // ~300px window can't fit that menu's full item set, and "Add to Playlist"
  // can't be a flyout, so it swaps the menu's contents in place instead.
  async function showCompactTrackMenu(x, y, track, opts = {}) {
    closeMenu();
    if (!track?.filePath) return;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu ctx-menu--compact glass-surface--elevated';
    menu.setAttribute('role', 'menu');

    const chevronRight = '<svg class="ctx-menu-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>';
    const chevronLeft = '<svg class="ctx-menu-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>';

    // Content swaps change the menu's height, so re-clamp after each.
    const reposition = () => {
      const r = menu.getBoundingClientRect();
      const c = clampToViewport(parseFloat(menu.style.left), parseFloat(menu.style.top), r.width, r.height);
      menu.style.left = `${c.x}px`;
      menu.style.top = `${c.y}px`;
    };

    const showMain = () => {
      menu.innerHTML = `
        <button class="ctx-menu-item" role="menuitem" data-play>Play</button>
        <button class="ctx-menu-item" role="menuitem" data-play-next>Play Next</button>
        <div class="ctx-menu-divider"></div>
        <button class="ctx-menu-item ctx-menu-item--drill" role="menuitem" data-open-playlists><span>Add to Playlist</span>${chevronRight}</button>
        <div class="ctx-menu-divider"></div>
        <button class="ctx-menu-item" role="menuitem" data-remove-from-queue>Remove from Queue</button>
      `;

      menu.querySelector('[data-play]').addEventListener('click', async () => {
        closeMenu();
        if (opts.onPlay) { opts.onPlay(); return; }
        const target = Number.isInteger(opts.queueIndex)
          ? ((await window.Musik?.queue?.jumpTo?.(opts.queueIndex)) ?? track)
          : track;
        if (window.MusikPlayerUI) await window.MusikPlayerUI.loadTrack(target);
      });

      menu.querySelector('[data-play-next]').addEventListener('click', () => {
        closeMenu();
        if (Number.isInteger(opts.queueIndex)) moveNextInQueue(track, opts.queueIndex);
        else enqueue(track, true);
      });

      menu.querySelector('[data-open-playlists]').addEventListener('click', showPlaylists);

      menu.querySelector('[data-remove-from-queue]').addEventListener('click', async () => {
        closeMenu();
        const live = (await window.Musik?.queue?.getQueue?.()) ?? [];
        const hit = live.find((t) => t.queueIndex === opts.queueIndex && t.filePath === track.filePath);
        if (hit) await window.Musik.queue.remove(opts.queueIndex);
        notifyQueueChanged();
      });

      reposition();
      menu.querySelector('.ctx-menu-item')?.focus({ preventScroll: true });
    };

    const showPlaylists = async () => {
      const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];
      menu.innerHTML = `
        <button class="ctx-menu-item ctx-menu-back" role="menuitem" data-back>${chevronLeft}<span>Add to Playlist</span></button>
        <div class="ctx-menu-divider"></div>
        ${playlists.length
          ? playlists.map((p) => `<button class="ctx-menu-item" role="menuitem" data-playlist-id="${escapeAttr(p.id)}">${escapeHTML(p.name)}</button>`).join('')
          : `<div class="ctx-menu-empty">No playlists yet</div>`}
      `;

      menu.querySelector('[data-back]').addEventListener('click', showMain);
      menu.querySelectorAll('[data-playlist-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await window.Musik?.library?.addTrack?.(btn.dataset.playlistId, track.filePath);
          closeMenu();
        });
      });

      reposition();
      (menu.querySelector('[data-playlist-id]') ?? menu.querySelector('.ctx-menu-item'))?.focus({ preventScroll: true });
    };

    mountMenu(menu, x, y);
    showMain();
  }

  async function showTrackMenu(x, y, track, opts = {}) {
    closeMenu();
    if (!track?.filePath) return;

    const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];
    const inQueue = Number.isInteger(opts.queueIndex);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu glass-surface--elevated';
    menu.innerHTML = `
      <button class="ctx-menu-item" data-play-track>Play</button>
      <button class="ctx-menu-item" data-play-next>Play Next</button>
      ${inQueue ? '' : `<button class="ctx-menu-item" data-add-to-queue>Add to Queue</button>`}
      <div class="ctx-menu-divider"></div>
      <div class="ctx-menu-label">Add to Playlist</div>
      ${playlists.length
        ? playlists.map((p) => `<button class="ctx-menu-item" data-playlist-id="${escapeAttr(p.id)}">${escapeHTML(p.name)}</button>`).join('')
        : `<div class="ctx-menu-empty">No playlists yet</div>`}
      <div class="ctx-menu-divider"></div>
      <button class="ctx-menu-item ctx-menu-item--new" data-new-playlist>+ New Playlist...</button>
      <div class="ctx-menu-divider"></div>
      <button class="ctx-menu-item" data-refresh-art>Refresh Cover Art</button>
      <div class="ctx-menu-divider"></div>
      ${inQueue ? `<button class="ctx-menu-item" data-remove-from-queue>Remove from Queue</button>` : ''}
      ${opts.playlistId ? `<button class="ctx-menu-item" data-remove-from-playlist>Remove from Playlist</button>` : ''}
      <button class="ctx-menu-item ctx-menu-item--danger" data-remove-from-library>Remove from Library</button>
    `;
    mountMenu(menu, x, y);

    menu.querySelector('[data-play-track]')?.addEventListener('click', async () => {
      closeMenu();
      await playTrack(track, opts.queueIndex);
    });

    menu.querySelector('[data-play-next]')?.addEventListener('click', () => {
      closeMenu();
      if (inQueue) moveNextInQueue(track, opts.queueIndex);
      else enqueue(track, true);
    });

    menu.querySelector('[data-add-to-queue]')?.addEventListener('click', () => {
      closeMenu();
      enqueue(track, false);
    });

    // Re-checks the slot at click time: the index was captured when the
    // panel rendered, and removing by a stale index would drop the wrong song.
    menu.querySelector('[data-remove-from-queue]')?.addEventListener('click', async () => {
      closeMenu();
      const live = (await window.Musik?.queue?.getQueue?.()) ?? [];
      const hit = live.find((t) => t.queueIndex === opts.queueIndex && t.filePath === track.filePath);
      if (hit) await window.Musik.queue.remove(opts.queueIndex);
      notifyQueueChanged();
    });

    menu.querySelectorAll('[data-playlist-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await addToPlaylist(btn.dataset.playlistId, track);
        closeMenu();
      });
    });

    menu.querySelector('[data-new-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      await newPlaylistWith(track);
    });

    menu.querySelector('[data-refresh-art]')?.addEventListener('click', async () => {
      closeMenu();
      await refreshArt(track);
    });

    menu.querySelector('[data-remove-from-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      await window.Musik?.library?.removeTrack?.(opts.playlistId, track.filePath);
      opts.onChange?.();
    });

    // Removes the track from the whole library (every playlist), never from
    // disk. The confirm text says so because "delete" reads scarier than it is.
    menu.querySelector('[data-remove-from-library]')?.addEventListener('click', async () => {
      closeMenu();
      // Fail loudly if the bridge method is missing: optional chaining alone
      // would let the user confirm, remove nothing, and still fire onChange.
      if (typeof window.Musik?.library?.removeTracks !== 'function') {
        window.MusikDialog?.alert?.('Remove from Library isn\'t available in this build.');
        return;
      }
      const ok = await window.MusikDialog?.confirm?.(`Remove "${track.title}" from Musik?`, {
        detail: 'The file stays on your computer.',
        confirmLabel: 'Remove',
      });
      if (!ok) return;
      await window.Musik.library.removeTracks([track.filePath]);
      opts.onChange?.();
    });
  }

  async function showPlaylistMenu(x, y, playlist, opts = {}) {
    closeMenu();
    if (!playlist?.id) return;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu glass-surface--elevated';
    menu.innerHTML = `
      <button class="ctx-menu-item" data-play-playlist>Play</button>
      <div class="ctx-menu-divider"></div>
      <button class="ctx-menu-item" data-rename-playlist>Rename...</button>
      <div class="ctx-menu-divider"></div>
      <button class="ctx-menu-item ctx-menu-item--danger" data-delete-playlist>Delete Playlist</button>
    `;
    mountMenu(menu, x, y);

    menu.querySelector('[data-play-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      await playPlaylist(playlist);
    });

    menu.querySelector('[data-rename-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      await renamePlaylist(playlist, opts.onChange);
    });

    menu.querySelector('[data-delete-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      await deletePlaylist(playlist, opts.onChange);
    });
  }

  function attachTrack(el, track, opts) {
    if (!el) return;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      (opts?.compact ? showCompactTrackMenu : showTrackMenu)(e.clientX, e.clientY, track, opts);
    });
  }

  function attachPlaylist(el, playlist, opts) {
    if (!el) return;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPlaylistMenu(e.clientX, e.clientY, playlist, opts);
    });
  }

  window.MusikContextMenu = {
    attachTrack,
    attachPlaylist,
    actions: {
      playTrack, enqueue, addToPlaylist, newPlaylistWith, refreshArt,
      playPlaylist, playlistTracks, renamePlaylist, deletePlaylist,
    },
  };
})();

// window.MusikPlaylistModals: shared "new playlist" flow (Custom Playlist /
// Import Folder), used by both Home and Library.
(function () {
  function openCreateModal() {
    const overlay = document.createElement('div');
    overlay.className = 'playlist-create-overlay';
    overlay.innerHTML = `
      <div class="playlist-create-modal glass-surface--elevated">
        <div class="playlist-create-header">
          <span>New Playlist</span>
          <button class="playlist-create-close" id="pcm-close" title="Close">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="playlist-create-options" id="pcm-options">
          <button class="playlist-create-option" id="pcm-custom" type="button">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            <span class="playlist-create-option-title">Custom Playlist</span>
            <span class="playlist-create-option-sub">Start empty, add tracks later</span>
          </button>
          <button class="playlist-create-option" id="pcm-folder" type="button">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
            <span class="playlist-create-option-title">Import Folder</span>
            <span class="playlist-create-option-sub">Scan a folder and build a playlist from it</span>
          </button>
        </div>

        <div class="playlist-create-status" id="pcm-status" hidden></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pcm-close').addEventListener('click', close);

    overlay.querySelector('#pcm-custom').addEventListener('click', async () => {
      const name = await window.MusikDialog.prompt('Playlist name:');
      if (name === null) return; // cancelled: leave the modal open
      const created = await window.Musik?.library?.createPlaylist?.(name);
      close();
      if (created) location.hash = `#/library/${encodeURIComponent(created.id)}`;
    });

    overlay.querySelector('#pcm-folder').addEventListener('click', async () => {
      // open-file-dialog picks files only; folders go through their own channel.
      const paths = await window.Musik?.dialog?.openFolder?.();
      if (!paths || !paths.length) return;
      const folderPath = paths[0];

      const options = overlay.querySelector('#pcm-options');
      const status = overlay.querySelector('#pcm-status');
      options.style.display = 'none';
      status.hidden = false;
      status.textContent = 'Scanning folder…';

      await window.Musik?.library?.scanFolder?.(folderPath);
      const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];
      const created = playlists.find((p) => p.folderPath === folderPath);

      if (created) {
        close();
        location.hash = `#/library/${encodeURIComponent(created.id)}`;
      } else {
        status.textContent = 'No folder detected there — please pick a folder, not individual files.';
        options.style.display = '';
      }
    });
  }

  window.MusikPlaylistModals = { openCreateModal };
})();
