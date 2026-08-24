// src/ui/media-session.js
// Wires the Web MediaSession API to Musik's event bus so the OS media
// overlay (Windows SMTC, macOS Now Playing, media keys) shows track info
// and can drive playback. Requires window.MusikPlayerUI + window.Musik.events.

(function () {
  if (!('mediaSession' in navigator)) {
    console.warn('[Musik] navigator.mediaSession unsupported in this runtime — OS media controls will stay blank.');
    return;
  }

  function artworkFrom(artData) {
    if (!artData?.base64 || !artData?.format) return [];
    const mime = artData.format.includes('/') ? artData.format : `image/${artData.format}`;
    const src = `data:${mime};base64,${artData.base64}`;
    return [
      { src, sizes: '96x96', type: mime },
      { src, sizes: '512x512', type: mime },
    ];
  }

  function updateMetadata(track) {
    if (!track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      album: track.album || '',
      artwork: artworkFrom(track.artData),
    });
    // Electron's taskbar/alt-tab preview follows document.title by default.
    // Just title — artist, nothing extra (no app-name suffix cluttering it).
    document.title = `${track.title || 'Unknown Title'} — ${track.artist || 'Unknown Artist'}`;
  }

  window.Musik.events.on('trackupdate', updateMetadata);
  window.Musik.events.on('artupdate', (artData) => {
    const current = window.MusikPlayerUI?.getCurrentTrackData?.();
    if (current) updateMetadata({ ...current, artData });
  });

  window.Musik.events.on('play', () => { navigator.mediaSession.playbackState = 'playing'; });
  window.Musik.events.on('pause', () => { navigator.mediaSession.playbackState = 'paused'; });

  navigator.mediaSession.setActionHandler('play', () => window.MusikPlayerUI?.togglePlayPause());
  navigator.mediaSession.setActionHandler('pause', () => window.MusikPlayerUI?.togglePlayPause());
  navigator.mediaSession.setActionHandler('previoustrack', () => window.MusikPlayerUI?.previous());
  navigator.mediaSession.setActionHandler('nexttrack', () => window.MusikPlayerUI?.next());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) window.MusikPlayerUI?.seek(details.seekTime);
  });

  window.Musik.events.on('progress', ({ currentTime, duration }) => {
    if (!duration || !isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(currentTime, duration),
      });
    } catch (_) {
      // stale/out-of-range mid track-swap — safe to skip a tick
    }
  });

  const current = window.MusikPlayerUI?.getCurrentTrackData?.();
  if (current) updateMetadata(current);
})();
