// src/ui/context-menu.js
//
// Shared right-click "Add to Playlist" menu for track rows. Same
// shared-utility-via-window-global pattern as MusikDialog/MusikCards.
// Any view with a track row wires it with one call:
//   window.MusikContextMenu.attachTrack(rowEl, track)
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

  async function showTrackMenu(x, y, track) {
    closeMenu();
    if (!track?.filePath) return;

    const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];

    const menu = document.createElement('div');
    menu.className = 'ctx-menu glass-surface--elevated';
    menu.innerHTML = `
      <div class="ctx-menu-label">Add to Playlist</div>
      ${playlists.length
        ? playlists.map((p) => `<button class="ctx-menu-item" data-playlist-id="${escapeAttr(p.id)}">${escapeHTML(p.name)}</button>`).join('')
        : `<div class="ctx-menu-empty">No playlists yet</div>`}
      <div class="ctx-menu-divider"></div>
      <button class="ctx-menu-item ctx-menu-item--new" data-new-playlist>+ New Playlist...</button>
      <div class="ctx-menu-divider"></div>
      <button class="ctx-menu-item" data-refresh-art>Refresh Cover Art</button>
    `;
    document.body.appendChild(menu);
    openMenuEl = menu;

    const rect = menu.getBoundingClientRect();
    const { x: cx, y: cy } = clampToViewport(x, y, rect.width, rect.height);
    menu.style.left = `${cx}px`;
    menu.style.top = `${cy}px`;

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

    // Deferred so the contextmenu event that opened this menu doesn't
    // immediately register as the "outside click" that closes it.
    setTimeout(() => {
      document.addEventListener('mousedown', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('scroll', closeMenu, true);
    }, 0);
  }

  function attachTrack(el, track) {
    if (!el) return;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTrackMenu(e.clientX, e.clientY, track);
    });
  }

  window.MusikContextMenu = { attachTrack };
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
      // Reuses the existing open-file-dialog channel (already supports
      // openDirectory) rather than adding a dedicated folder-only picker.
      // Only the first selected entry is used; scanFolder() no-ops
      // silently on a non-folder path, which is detected below and
      // surfaced as an error instead of leaving the user guessing.
      const paths = await window.Musik?.dialog?.openFile?.();
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
