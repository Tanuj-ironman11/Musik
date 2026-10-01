// src/ui/context-menu.js
//
// Shared right-click menus for track rows and playlist cards. Same
// shared-utility-via-window-global pattern as MusikDialog/MusikCards.
// Any view wires them with one call:
//   window.MusikContextMenu.attachTrack(rowEl, track, opts)
//   window.MusikContextMenu.attachPlaylist(cardEl, playlist, opts)
// opts (optional, both):
//   onChange   — called after a menu action changed library data (removed a
//                track, deleted/renamed a playlist), so the owning view can
//                re-render itself.
//   playlistId — attachTrack only: the playlist the row is being shown in.
//                Adds "Remove from Playlist" to that row's menu.
//
// Simplification: single-level menu (playlist names listed directly)
// rather than a nested "Add to Playlist ▸" submenu — avoids viewport-edge
// submenu positioning complexity for a first pass. Revisit if playlist
// counts get large enough to want a search/filter instead.

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
    if (e.key === 'Escape') closeMenu();
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

  async function showTrackMenu(x, y, track, opts = {}) {
    closeMenu();
    if (!track?.filePath) return;

    const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];

    const menu = document.createElement('div');
    menu.className = 'ctx-menu glass-surface--elevated';
    menu.innerHTML = `
      <button class="ctx-menu-item" data-play-track>Play</button>
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
      ${opts.playlistId ? `<button class="ctx-menu-item" data-remove-from-playlist>Remove from Playlist</button>` : ''}
      <button class="ctx-menu-item ctx-menu-item--danger" data-remove-from-library>Remove from Library</button>
    `;
    mountMenu(menu, x, y);

    menu.querySelector('[data-play-track]')?.addEventListener('click', async () => {
      closeMenu();
      if (window.MusikPlayerUI) await window.MusikPlayerUI.loadTrack(track);
    });

    menu.querySelectorAll('[data-playlist-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await window.Musik?.library?.addTrack?.(btn.dataset.playlistId, track.filePath);
        closeMenu();
      });
    });

    menu.querySelector('[data-new-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      const name = await window.MusikDialog?.prompt?.('New playlist name:');
      if (name === null || name === undefined) return;
      const created = await window.Musik?.library?.createPlaylist?.(name);
      if (created) await window.Musik?.library?.addTrack?.(created.id, track.filePath);
    });

    // NOTE: this refreshes art for the CURRENT SESSION only — broadcasts an
    // artupdate so accent-extractor/player-bar/etc pick it up live, but does
    // NOT persist to musik-library.json. There's no library:update-art IPC
    // channel yet. Restarting the app reverts to whatever was embedded/cached
    // originally. Flagging rather than pretending this is a permanent fix.
    menu.querySelector('[data-refresh-art]')?.addEventListener('click', async () => {
      closeMenu();
      let artData = await window.Musik?.art?.extract?.(track.filePath);
      if (!artData && track.artist && track.album) {
        artData = await window.Musik?.art?.fetchOnline?.({ artist: track.artist, album: track.album });
      }
      if (artData) {
        window.Musik?.events?.emit('artupdate', artData);
      } else {
        window.MusikDialog?.alert?.('No cover art found for this track.');
      }
    });

    menu.querySelector('[data-remove-from-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      await window.Musik?.library?.removeTrack?.(opts.playlistId, track.filePath);
      opts.onChange?.();
    });

    // Removes the track from the whole library (every playlist), never from
    // disk — the confirm text says so because "delete" reads scarier than it is.
    menu.querySelector('[data-remove-from-library]')?.addEventListener('click', async () => {
      closeMenu();
      // Fail loudly if the bridge method is missing — optional chaining alone
      // would let the user confirm, remove nothing, and still fire onChange.
      if (typeof window.Musik?.library?.removeTracks !== 'function') {
        window.MusikDialog?.alert?.('Remove from Library isn\'t available in this build.');
        return;
      }
      const ok = await window.MusikDialog?.confirm?.(`Remove "${track.title}" from Musik? The file stays on your computer.`);
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
      // Re-read at click time — the playlist object passed in was captured
      // when the view rendered and may be stale by now.
      const [allPlaylists, allTracks] = await Promise.all([
        window.Musik?.library?.getPlaylists?.(),
        window.Musik?.library?.getTracks?.(),
      ]);
      const fresh = (allPlaylists ?? []).find((p) => p.id === playlist.id) ?? playlist;
      const list = (fresh.trackIds || [])
        .map((id) => (allTracks ?? []).find((t) => t.filePath === id))
        .filter(Boolean);
      if (list.length && window.MusikPlayerUI) {
        window.MusikPlayerUI.playQueue?.(list) ?? window.MusikPlayerUI.loadTrack(list[0]);
      }
    });

    menu.querySelector('[data-rename-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      const newName = await window.MusikDialog?.prompt?.('Rename playlist:', playlist.name);
      if (newName === null || newName === undefined) return;
      await window.Musik?.library?.renamePlaylist?.(playlist.id, newName);
      opts.onChange?.();
    });

    // Deletes the playlist only — its tracks stay in the library.
    menu.querySelector('[data-delete-playlist]')?.addEventListener('click', async () => {
      closeMenu();
      const ok = await window.MusikDialog?.confirm?.(`Delete "${playlist.name}"? Its tracks stay in your library.`);
      if (!ok) return;
      await window.Musik?.library?.deletePlaylist?.(playlist.id);
      opts.onChange?.();
    });
  }

  function attachTrack(el, track, opts) {
    if (!el) return;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTrackMenu(e.clientX, e.clientY, track, opts);
    });
  }

  function attachPlaylist(el, playlist, opts) {
    if (!el) return;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPlaylistMenu(e.clientX, e.clientY, playlist, opts);
    });
  }

  window.MusikContextMenu = { attachTrack, attachPlaylist };
})();

// ---------------------------------------------------------------------------
// window.MusikPlaylistModals — shared "new playlist" flow (Custom Playlist /
// Import Folder), called from both Home and Library so they stop drifting
// into separate implementations. Lives here rather than its own file — this
// module was already the home for shared overlay/menu utilities.
// ---------------------------------------------------------------------------
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
      if (name === null) return; // cancelled — leave the modal open
      const created = await window.Musik?.library?.createPlaylist?.(name);
      close();
      if (created) location.hash = `#/library/${encodeURIComponent(created.id)}`;
    });

    overlay.querySelector('#pcm-folder').addEventListener('click', async () => {
      // open-file-dialog is file-only now (main.js split it from a combined
      // openFile+openDirectory dialog, which Windows can't actually present
      // as one picker — it silently collapsed to folder-only there, which
      // is what broke single-file adds elsewhere). Folder picking now goes
      // through its own dedicated channel.
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
