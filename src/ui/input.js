// src/ui/input.js
// Shortcut registry (MusikKeys) and OS media session (media keys, SMTC, Now Playing).

// Registry of built-in shortcuts, for custom-shortcut conflict checks.
// Combo: "Mod+Alt+Shift+Code" (Mod = Ctrl/Cmd, Code = e.code), e.g. "Mod+ArrowLeft".
window.MusikKeys = (function () {
  const map = new Map();

  function parse(str) {
    const parts = str.split('+');
    const code = parts.pop();
    return { mod: parts.includes('Mod'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), code };
  }

  function key(c) {
    const o = typeof c === 'string' ? parse(c) : c;
    return [o.mod && 'Mod', o.alt && 'Alt', o.shift && 'Shift', o.code].filter(Boolean).join('+');
  }

  // Returns an unregister fn.
  function reg(combo, label) {
    const k = key(combo);
    map.set(k, label);
    return () => { if (map.get(k) === label) map.delete(k); };
  }

  function find(combo) {
    return map.get(key(combo)) ?? null;
  }

  // Seeds until each key handler registers its own.
  reg('Space', 'play/pause');
  ['Left', 'Right', 'Up', 'Down'].forEach((d) => reg(`Mod+Arrow${d}`, 'a player shortcut'));
  reg('Alt+F4', 'close window');
  reg('Alt+Space', 'the window menu');

  return { reg, find, list: () => [...map] };
})();

// Media session. Needs window.MusikPlayerUI + window.Musik.events.
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
    // Taskbar/alt-tab preview follows document.title.
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
      // stale mid track-swap; skip a tick
    }
  });

  const current = window.MusikPlayerUI?.getCurrentTrackData?.();
  if (current) updateMetadata(current);
})();
