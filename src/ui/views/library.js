// src/ui/views/library.js
//
// #/library            -> grid of all playlists (same card treatment as
//                          Home's playlist row, via window.MusikCards).
// #/library/<name>     -> single playlist detail: header + track list.
//
// Relies on window.MusikCards (defined in home.js) for shared
// playlist-card markup/wiring — make sure home.js loads first.
// Relies on window.MusikPlaylistModals (playlist-modals.js) for the
// shared "new playlist" flow — make sure that loads before this fires.

window.MusikViews = window.MusikViews || {};

window.MusikViews.library = async function renderLibrary(main, param) {
  const tracks = (await window.Musik?.library?.getTracks?.()) ?? [];
  const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];

  if (param) {
    renderPlaylistDetail(main, param, tracks, playlists);
  } else {
    renderPlaylistGrid(main, tracks, playlists);
  }
};

function renderPlaylistGrid(main, tracks, playlists) {
  main.innerHTML = `
    <div class="home-wrap">
      <div class="home-topbar">
        <h1 class="view-title">Library</h1>
        <div class="view-actions">
          <button id="lib-new-playlist-btn" class="home-add-icon-btn" title="New playlist">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path class="icon-playlist-lines" d="M4 6h16M4 12h10M4 18h6"/><path class="icon-playlist-plus" d="M18 14v6M15 17h6"/></svg>
          </button>
        </div>
      </div>
      <div id="library-body"></div>
    </div>
  `;

  document.getElementById('lib-new-playlist-btn').addEventListener('click', (e) => {
    window.MusikIconKick?.(e.currentTarget);
    window.MusikPlaylistModals.openCreateModal();
  });

  const body = document.getElementById('library-body');

  if (!playlists.length) {
    body.innerHTML = `
      <div class="home-empty">
        <div class="home-empty-icon">
          <svg viewBox="0 0 24 24"><path d="M4 4h2v16H4zM9 4h2v16H9zM14 4h6v3h-6zM14 9h6v3h-6zM14 14h6v3h-6z"/></svg>
        </div>
        <div class="home-empty-title">No playlists yet</div>
        <div class="home-empty-sub">Create one with the + button above.</div>
      </div>
    `;
    return;
  }

  body.innerHTML = `
    <div class="home-section">
      <div class="home-playlists-row">
        ${playlists.map((p) => window.MusikCards.playlistCardHTML(p, tracks)).join('')}
      </div>
    </div>
  `;

  window.MusikCards.wirePlaylistCards(body, playlists, tracks);
}

function renderPlaylistDetail(main, id, tracks, playlists) {
  const playlist = playlists.find((p) => p.id === id);

  if (!playlist) {
    main.innerHTML = `
      <div class="home-wrap">
        <button class="lib-back-btn" id="lib-back-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
          Back to Library
        </button>
        <div class="home-empty">
          <div class="home-empty-title">Playlist not found</div>
          <div class="home-empty-sub">It may have been deleted.</div>
        </div>
      </div>
    `;
    document.getElementById('lib-back-btn').addEventListener('click', (e) => {
      window.MusikIconKick?.(e.currentTarget);
      location.hash = '#/library';
    });
    return;
  }

  const playlistTracks = (playlist.trackIds || [])
    .map((id) => tracks.find((t) => t.filePath === id))
    .filter(Boolean);

  const withArt = playlistTracks.filter((t) => t.artData?.base64);
  const shuffledCovers = [...withArt].sort(() => Math.random() - 0.5).slice(0, 4);

  let artHTML;
  if (shuffledCovers.length === 4) {
    artHTML = `
      <div class="home-collage">
        ${shuffledCovers.map((t) => `<div class="home-collage-cell"><img src="${window.MusikCards.artSrc(t)}" alt=""></div>`).join('')}
      </div>
    `;
  } else if (shuffledCovers.length > 0) {
    artHTML = `<img class="home-collage-single" src="${window.MusikCards.artSrc(shuffledCovers[0])}" alt="">`;
  } else {
    artHTML = `
      <div class="home-collage-cell--empty">
        <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
      </div>
    `;
  }

  const totalSeconds = playlistTracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const totalMinutes = Math.round(totalSeconds / 60);

  main.innerHTML = `
    <div class="home-wrap">
      <button class="lib-back-btn" id="lib-back-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        Back to Library
      </button>

      <div class="lib-playlist-header">
        <div class="lib-playlist-art">${artHTML}</div>
        <div class="lib-playlist-info">
          <span class="lib-playlist-label">Playlist</span>
          <h1 class="lib-playlist-title">${window.MusikCards.escapeHTML(playlist.name)}</h1>
          <div class="lib-playlist-meta">${playlistTracks.length} tracks · ${totalMinutes} min</div>
          <div class="lib-playlist-actions">
            <button class="lib-action-btn lib-action-btn--primary" id="lib-play-btn">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              Play
            </button>
            <button class="lib-action-btn" id="lib-shuffle-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path class="icon-shuffle-arrow" d="M16 3h5v5"/>
                <path class="icon-shuffle-strand-a" d="M4 20L21 3"/>
                <path class="icon-shuffle-arrow" d="M21 16v5h-5"/>
                <path class="icon-shuffle-strand-b" d="M15 15l6 6"/>
                <path class="icon-shuffle-strand-b" d="M4 4l5 5"/>
              </svg>
              Shuffle
            </button>
            <button class="lib-action-btn" id="lib-add-tracks-btn">Add tracks</button>
            <button class="lib-action-btn" id="lib-rename-btn">Rename</button>
            <button class="lib-action-btn" id="lib-delete-btn">Delete</button>
          </div>
        </div>
      </div>

      <div class="lib-track-list">
        ${playlistTracks.map((t, i) => trackRowHTML(t, i)).join('')}
      </div>
    </div>
  `;

  document.getElementById('lib-back-btn').addEventListener('click', (e) => {
    window.MusikIconKick?.(e.currentTarget);
    location.hash = '#/library';
  });

  document.getElementById('lib-play-btn').addEventListener('click', (e) => {
    window.MusikIconKick?.(e.currentTarget);
    if (playlistTracks.length && window.MusikPlayerUI) {
      window.MusikPlayerUI.playQueue?.(playlistTracks) ?? window.MusikPlayerUI.loadTrack(playlistTracks[0]);
    }
  });

  document.getElementById('lib-shuffle-btn').addEventListener('click', (e) => {
    window.MusikIconKick?.(e.currentTarget);
    if (!playlistTracks.length || !window.MusikPlayerUI) return;
    const shuffled = [...playlistTracks].sort(() => Math.random() - 0.5);
    window.MusikPlayerUI.playQueue?.(shuffled, { shuffle: true }) ?? window.MusikPlayerUI.loadTrack(shuffled[0]);
  });

  document.getElementById('lib-add-tracks-btn').addEventListener('click', (e) => {
    window.MusikIconKick?.(e.currentTarget);
    openAddTracksModal(main, playlist, tracks);
  });

  document.getElementById('lib-rename-btn').addEventListener('click', async (e) => {
    window.MusikIconKick?.(e.currentTarget);
    const newName = await window.MusikDialog.prompt('Rename playlist:', playlist.name);
    if (newName === null) return;
    await window.Musik?.library?.renamePlaylist?.(playlist.id, newName);
    window.MusikViews.library(main, playlist.id); // re-render with fresh data
  });

  document.getElementById('lib-delete-btn').addEventListener('click', async (e) => {
    window.MusikIconKick?.(e.currentTarget);
    if (!(await window.MusikDialog.confirm(`Delete "${playlist.name}"? This can't be undone.`))) return;
    await window.Musik?.library?.deletePlaylist?.(playlist.id);
    location.hash = '#/library';
  });

  main.querySelectorAll('[data-track-row-path]').forEach((row) => {
    const t = tracks.find((tr) => tr.filePath === row.dataset.trackRowPath);

    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-remove-track]')) return; // don't play when removing
      if (t && window.MusikPlayerUI) await window.MusikPlayerUI.loadTrack(t);
    });

    if (t) window.MusikContextMenu?.attachTrack?.(row, t);

    row.querySelector('[data-remove-track]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      row.classList.add('lib-track-row--removing');
      await new Promise((resolve) => {
        row.addEventListener('animationend', resolve, { once: true });
      });
      await window.Musik?.library?.removeTrack?.(playlist.id, row.dataset.trackRowPath);
      window.MusikViews.library(main, playlist.id);
    });
  });

  wireTrackReorder(main, playlist);
}

// Native HTML5 drag-and-drop reorder for the track list. Kept plain
// (no library) since this is the only place in the app that needs
// drag-reorder right now — matches the "no new systems stacked on old
// ones" rule better than pulling in a dependency for one list.
function wireTrackReorder(main, playlist) {
  const rows = Array.from(main.querySelectorAll('[data-track-row-path]'));
  let dragFromIndex = null;

  rows.forEach((row, index) => {
    row.setAttribute('draggable', 'true');

    row.addEventListener('dragstart', () => {
      dragFromIndex = index;
      row.classList.add('lib-track-row--dragging');
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('lib-track-row--dragging');
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('lib-track-row--drop-target');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('lib-track-row--drop-target');
    });

    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('lib-track-row--drop-target');
      if (dragFromIndex === null || dragFromIndex === index) return;
      await window.Musik?.library?.reorderTracks?.(playlist.id, dragFromIndex, index);
      window.MusikViews.library(main, playlist.id);
    });
  });
}

// Lists every library track NOT already in the playlist, checkbox-select,
// bulk-adds on confirm via the existing addTrackToPlaylist IPC (one call
// per selected track — no bulk-add channel exists, and library sizes here
// don't warrant adding one yet). Also offers "Add from Computer" — picks
// files off disk, gets them into the library via the new addFiles() call,
// then adds them to this playlist. Files already in the library just get
// added to the playlist directly; addFiles() itself no-ops anything it
// already knows about.
function openAddTracksModal(main, playlist, allTracks) {
  const inPlaylist = new Set(playlist.trackIds || []);
  const available = allTracks.filter((t) => !inPlaylist.has(t.filePath));

  const overlay = document.createElement('div');
  overlay.className = 'add-tracks-overlay';
  overlay.innerHTML = `
    <div class="add-tracks-modal glass-surface--elevated">
      <div class="add-tracks-header">
        <span>Add tracks to "${window.MusikCards.escapeHTML(playlist.name)}"</span>
        <button class="add-tracks-close" id="add-tracks-close" title="Close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="add-tracks-list" id="add-tracks-list">
        ${available.length
          ? available.map((t) => `
            <label class="add-tracks-row">
              <input type="checkbox" data-track-path="${window.MusikCards.escapeAttr(t.filePath)}">
              <div>
                <div class="add-tracks-row-title">${window.MusikCards.escapeHTML(t.title)}</div>
                <div class="add-tracks-row-artist">${window.MusikCards.escapeHTML(t.artist)}</div>
              </div>
            </label>
          `).join('')
          : `<div class="add-tracks-empty">All tracks are already in this playlist.</div>`}
      </div>
      <div class="add-tracks-footer">
        <button class="lib-action-btn" id="add-tracks-import-btn">Add from Computer</button>
        <button class="lib-action-btn" id="add-tracks-cancel">Cancel</button>
        <button class="lib-action-btn lib-action-btn--primary" id="add-tracks-confirm">Add Selected</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.getElementById('add-tracks-close').addEventListener('click', close);
  document.getElementById('add-tracks-cancel').addEventListener('click', close);

  document.getElementById('add-tracks-import-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const paths = await window.Musik?.dialog?.openFile?.();
    if (!paths || !paths.length) return;

    btn.disabled = true;
    btn.textContent = 'Adding…';
    // addFiles() skips directories on its own (folders belong to the
    // Import Folder flow, not here) — safe to pass whatever the dialog
    // returned straight through.
    await window.Musik?.library?.addFiles?.(paths);
    for (const filePath of paths) {
      await window.Musik?.library?.addTrack?.(playlist.id, filePath);
    }
    close();
    window.MusikViews.library(main, playlist.id);
  });

  document.getElementById('add-tracks-confirm').addEventListener('click', async () => {
    const checked = Array.from(overlay.querySelectorAll('input[type="checkbox"]:checked'))
      .map((el) => el.dataset.trackPath);
    for (const filePath of checked) {
      await window.Musik?.library?.addTrack?.(playlist.id, filePath);
    }
    close();
    window.MusikViews.library(main, playlist.id);
  });
}

function trackRowHTML(track, index) {
  const hasArt = track.artData?.base64;
  const art = hasArt
    ? `<img src="${window.MusikCards.artSrc(track)}" alt="">`
    : `<div class="lib-track-art-placeholder"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></div>`;

  return `
    <div class="lib-track-row" data-track-row-path="${window.MusikCards.escapeAttr(track.filePath)}">
      <span class="lib-track-num">${index + 1}</span>
      <div class="lib-track-art">${art}</div>
      <div class="lib-track-info">
        <span class="lib-track-title">${window.MusikCards.escapeHTML(track.title)}</span>
        <span class="lib-track-artist">${window.MusikCards.escapeHTML(track.artist)}</span>
      </div>
      <span class="lib-track-duration">${fmtTime(track.duration)}</span>
      <button class="lib-track-remove-btn" data-remove-track title="Remove from playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  `;
}

function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
