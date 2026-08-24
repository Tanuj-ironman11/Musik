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
