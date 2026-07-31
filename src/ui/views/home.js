// src/ui/views/home.js
// Renders into #main for the #/home route.

window.MusikViews = window.MusikViews || {};

const iconKickTimers = new WeakMap();
function spawnIconKick(btn) {
  if (!btn) return;
  btn.classList.remove('icon-kick');
  void btn.offsetWidth;
  btn.classList.add('icon-kick');
  clearTimeout(iconKickTimers.get(btn));
  const t = setTimeout(() => btn.classList.remove('icon-kick'), 650);
  iconKickTimers.set(btn, t);
}
window.MusikIconKick = spawnIconKick;

function getGreeting(date) {
  const h = date.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

function formatClock(date) {
  let h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function startHomeClock() {
  const tick = () => {
    const greetingEl = document.getElementById('home-greeting');
    const clockEl = document.getElementById('home-clock');
    if (!greetingEl || !clockEl) {
      clearInterval(intervalId);
      return;
    }
    const now = new Date();
    greetingEl.textContent = getGreeting(now);
    clockEl.textContent = formatClock(now);
  };
  tick();
  const intervalId = setInterval(tick, 1000);
}

window.MusikViews.home = async function renderHome(main) {
  main.innerHTML = `
    <div class="home-wrap">
      <div class="home-topbar">
        <div class="home-greeting-wrap">
          <h1 class="home-greeting" id="home-greeting"></h1>
          <div class="home-clock" id="home-clock"></div>
        </div>
        <div class="view-actions">
          <button id="home-add-music-btn" class="home-add-icon-btn" title="Add music">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path class="icon-plus-v" d="M12 5v14"/><path class="icon-plus-h" d="M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div id="home-body"></div>
    </div>
  `;

  startHomeClock();

  document.getElementById('home-add-music-btn').addEventListener('click', async (e) => {
    spawnIconKick(e.currentTarget);
    const paths = await window.Musik.dialog.openFile();
    if (paths && paths.length && window.MusikPlayerUI) {
      await window.MusikPlayerUI.playFiles(paths);
      renderHome(main);
    }
  });

  const body = document.getElementById('home-body');
  const tracks = (await window.Musik?.library?.getTracks?.()) ?? [];
  const playlists = (await window.Musik?.library?.getPlaylists?.()) ?? [];

  if (!tracks.length && !playlists.length) {
    body.innerHTML = `
      <div class="home-empty">
        <div class="home-empty-icon">
          <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
        </div>
        <div class="home-empty-title">No music yet</div>
        <div class="home-empty-sub">Add files or a folder to get started.</div>
        <button id="home-empty-add-btn" class="home-add-btn">Add music</button>
      </div>
    `;
    document.getElementById('home-empty-add-btn').addEventListener('click', () => {
      document.getElementById('home-add-music-btn').click();
    });
    return;
  }

  let html = '';

  if (tracks.length) {
    const played = tracks
      .filter((t) => t.lastPlayedAt)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, 8);

    if (played.length) {
      html += `
        <div class="home-section">
          <h2 class="view-title" style="font-size:16px; margin-bottom:12px;">Recently played</h2>
          <div class="home-recent-grid">
            ${played.map(trackCardHTML).join('')}
          </div>
        </div>
      `;
    }
  }

  if (playlists.length) {
    html += `
      <div class="home-section">
        <h2 class="view-title" style="font-size:16px; margin-bottom:12px;">Playlists</h2>
        <div class="home-playlists-row">
          ${playlists.map((p) => playlistCardHTML(p, tracks)).join('')}
        </div>
      </div>
    `;
  }

  body.innerHTML = html;

  body.querySelectorAll('[data-track-path]').forEach((el) => {
    const t = tracks.find((tr) => tr.filePath === el.dataset.trackPath);

    el.addEventListener('click', async () => {
      if (t && window.MusikPlayerUI) await window.MusikPlayerUI.loadTrack(t);
    });

    if (t) window.MusikContextMenu?.attachTrack?.(el, t);
  });

  window.MusikCards.wirePlaylistCards(body, playlists, tracks);
};

function trackCardHTML(track) {
  const hasArt = track.artData?.base64;
  const artSrc = hasArt
    ? `data:image/${track.artData.format || 'jpeg'};base64,${track.artData.base64}`
    : null;
  return `
    <div class="lib-card" data-track-path="${escapeAttr(track.filePath)}">
      <div class="lib-card-art">
        ${artSrc
          ? `<img src="${artSrc}" alt="">`
          : `<div class="pb-art--placeholder"><svg class="placeholder-note-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></div>`}
      </div>
      <div class="home-playlist-name">${escapeHTML(track.title)}</div>
      <div class="home-playlist-count">${escapeHTML(track.artist)}</div>
    </div>
  `;
}

function playlistCardHTML(playlist, allTracks) {
  const playlistTracks = (playlist.trackIds || [])
    .map((id) => allTracks.find((t) => t.filePath === id))
    .filter(Boolean);

  const withArt = playlistTracks.filter((t) => t.artData?.base64);
  const shuffled = [...withArt].sort(() => Math.random() - 0.5);
  const covers = shuffled.slice(0, 4);

  let collageHTML;
  if (covers.length === 4) {
    collageHTML = `
      <div class="home-collage">
        ${covers.map((t) => `<div class="home-collage-cell"><img src="${artSrc(t)}" alt=""></div>`).join('')}
      </div>
    `;
  } else if (covers.length > 0) {
    collageHTML = `<img class="home-collage-single" src="${artSrc(covers[0])}" alt="">`;
  } else {
    collageHTML = `
      <div class="home-collage-cell--empty">
        <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
      </div>
    `;
  }

  return `
    <div class="home-playlist-card" data-playlist-id="${escapeAttr(playlist.id)}">
      <div class="home-playlist-art">
        ${collageHTML}
        <div class="home-playlist-hover">
          <button class="home-playlist-hover-btn" data-playlist-action="play" title="Play">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="home-playlist-hover-btn" data-playlist-action="shuffle" title="Shuffle play">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path class="icon-shuffle-arrow" d="M16 3h5v5"/>
              <path class="icon-shuffle-strand-a" d="M4 20L21 3"/>
              <path class="icon-shuffle-arrow" d="M21 16v5h-5"/>
              <path class="icon-shuffle-strand-b" d="M15 15l6 6"/>
              <path class="icon-shuffle-strand-b" d="M4 4l5 5"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="home-playlist-name">${escapeHTML(playlist.name)}</div>
      <div class="home-playlist-count">${(playlist.trackIds || []).length} tracks</div>
    </div>
  `;
}

function artSrc(track) {
  return `data:image/${track.artData.format || 'jpeg'};base64,${track.artData.base64}`;
}

window.MusikCards = { trackCardHTML, playlistCardHTML, artSrc, escapeHTML, escapeAttr, wirePlaylistCards };

function wirePlaylistCards(container, playlists, tracks) {
  container.querySelectorAll('.home-playlist-card').forEach((card) => {
    const id = card.dataset.playlistId;
    const playlist = playlists.find((p) => p.id === id);
    const playlistTracks = (playlist?.trackIds || [])
      .map((tid) => tracks.find((t) => t.filePath === tid))
      .filter(Boolean);

    card.querySelector('[data-playlist-action="play"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      spawnIconKick(e.currentTarget);
      if (playlistTracks.length && window.MusikPlayerUI) {
        window.MusikPlayerUI.playQueue?.(playlistTracks) ?? window.MusikPlayerUI.loadTrack(playlistTracks[0]);
      }
    });

    card.querySelector('[data-playlist-action="shuffle"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      spawnIconKick(e.currentTarget);
      if (!playlistTracks.length || !window.MusikPlayerUI) return;
      const shuffled = [...playlistTracks].sort(() => Math.random() - 0.5);
      window.MusikPlayerUI.playQueue?.(shuffled, { shuffle: true }) ?? window.MusikPlayerUI.loadTrack(shuffled[0]);
    });

    card.addEventListener('click', () => {
      location.hash = `#/library/${encodeURIComponent(id)}`;
    });
  });
}

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(str) {
  return escapeHTML(str);
}
