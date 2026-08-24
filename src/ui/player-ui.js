// src/ui/player-ui.js
// Renderer-side playback for the MAIN window only. Web Audio graph lives
// here per the brief: MediaElementAudioSourceNode -> AnalyserNode -> destination.

(function () {
  // 10-band graphic EQ, ISO-standard center frequencies. Nodes are always
  // wired into the graph (source -> eqNodes[0..9] -> analyser -> dest) —
  // "off" just means every band forced to 0dB gain at render time, not
  // node removal, so toggling/tier-switching never touches live graph
  // topology mid-playback. eq.js owns the actual gain/freq/Q values and
  // re-applies them to fresh nodes on every 'audiograph-rebuilt' (a new
  // AudioContext + node set is created per track, see createAudioGraph).
  const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  let audioCtx = null;
  let sourceNode = null;
  let analyserNode = null;
  let eqNodes = [];
  let audioEl = null; // swappable — MediaElementAudioSourceNode is one-per-element for life
  let currentTrack = null;
  let currentVolume = 1.0; // user's actual volume setting, survives graph rebuilds
  let duckMultiplier = 1.0; // from game-duck 'duckupdate', applied on top of currentVolume

  let trackStartTimestamp = 0;
  let hasScrobbled = false;

  // Continuous loudness metering (rolling short-term BS.1770 estimate) feeds
  // game-duck's auto-boost. Separate analyser chain, never connected to
  // destination, so it can't affect audible output.
  let loudnessFilterHigh = null;
  let loudnessFilterRLB = null;
  let loudnessAnalyser = null;
  let loudnessInterval = null;
  let loudnessRmsHistory = []; // [{ meanSquare, t }]
  const LOUDNESS_WINDOW_MS = 3000; // BS.1770 short-term window
  const LOUDNESS_TICK_MS = 200;

  function applyEffectiveVolume() {
    if (audioEl) audioEl.volume = Math.max(0, Math.min(1, currentVolume * duckMultiplier));
  }

  function createAudioGraph() {
    // Must pause + detach old element BEFORE closing the AudioContext, or it
    // can keep decoding unrouted in the background — this was the source of
    // the volume desync bug (stale elements each holding their own gain).
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
      } catch (_) {}
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
    }
    stopLoudnessMetering();

    audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.volume = Math.max(0, Math.min(1, currentVolume * duckMultiplier)); // new elements default to 1.0

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audioEl);
    analyserNode = audioCtx.createAnalyser();
    // Lower smoothing so the sidebar's tiny EQ bars read snappy; per-bar
    // visual smoothing happens in app.js instead.
    analyserNode.smoothingTimeConstant = 0.35;
    analyserNode.fftSize = 512;

    // EQ chain: 10 peaking filters in series, source -> eq -> analyser.
    // Fresh nodes every graph rebuild (see comment above) — eq.js reapplies
    // its persisted gain/freq/Q onto these via 'audiograph-rebuilt' below.
    eqNodes = EQ_FREQUENCIES.map((freq) => {
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1.0;
      filter.gain.value = 0; // flat until eq.js applies saved state
      return filter;
    });
    sourceNode.connect(eqNodes[0]);
    for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
    const eqOutput = eqNodes[eqNodes.length - 1];

    eqOutput.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    // Loudness tap — independent branch, never reaches destination.
    // highshelf + highpass approximate BS.1770's K-weighting pre-filter.
    // Tapped POST-EQ (off eqOutput, not sourceNode) so game-duck measures
    // what's actually audible — a bass-boosted track really is louder,
    // duck math should see that rather than the pre-EQ signal.
    loudnessFilterHigh = audioCtx.createBiquadFilter();
    loudnessFilterHigh.type = 'highshelf';
    loudnessFilterHigh.frequency.value = 1500;
    loudnessFilterHigh.gain.value = 4;

    loudnessFilterRLB = audioCtx.createBiquadFilter();
    loudnessFilterRLB.type = 'highpass';
    loudnessFilterRLB.frequency.value = 38;

    loudnessAnalyser = audioCtx.createAnalyser();
    loudnessAnalyser.fftSize = 2048;

    eqOutput.connect(loudnessFilterHigh);
    loudnessFilterHigh.connect(loudnessFilterRLB);
    loudnessFilterRLB.connect(loudnessAnalyser);

    // eq.js listens for this to reapply saved band values to the fresh nodes.
    window.Musik?.events?.push('audiograph-rebuilt', { eqNodes });

    audioEl.addEventListener('play', () => window.Musik.events.push('play', currentTrack));
    audioEl.addEventListener('pause', () => window.Musik.events.push('pause', currentTrack));
    audioEl.addEventListener('timeupdate', () => {
      window.Musik.events.emit('seek', { seconds: audioEl.currentTime });
      window.Musik.events.push('progress', {
        currentTime: audioEl.currentTime,
        duration: audioEl.duration || (currentTrack?.duration ?? 0),
      });

      // Scrobble rule: 50% played or 4min, whichever first; <30s never qualifies.
      const duration = audioEl.duration || (currentTrack?.duration ?? 0);
      if (!hasScrobbled && currentTrack && duration >= 30) {
        const threshold = Math.min(duration * 0.5, 240);
        if (audioEl.currentTime >= threshold) {
          hasScrobbled = true;
          window.Musik.scrobble?.submitScrobble?.(currentTrack, trackStartTimestamp);
          window.Musik.stats?.recordPlay?.(currentTrack);
        }
      }
    });
    audioEl.addEventListener('error', () => {
      const err = audioEl.error;
      console.error('[Musik] audio element error', {
        code: err?.code,
        message: err?.message,
        src: audioEl.src,
        track: currentTrack,
      });
      window.Musik.events.emit('playbackerror', { code: err?.code, message: err?.message, track: currentTrack });
    });
    audioEl.addEventListener('ended', () => {
      window.Musik.events.push('pause', currentTrack);
      if (window.MusikPlayerUI) window.MusikPlayerUI.next();
    });
    // audioEl.volume is EFFECTIVE volume (currentVolume * duckMultiplier).
    // `volume` here stays the honest user-set value; `effectiveVolume`
    // carries the ducked number for meters/debug.
    audioEl.addEventListener('volumechange', () => {
      window.Musik.events.push('volumechange', {
        volume: currentVolume,
        effectiveVolume: audioEl.volume,
      });
    });

    return audioEl;
  }

  function stopLoudnessMetering() {
    if (loudnessInterval) {
      clearInterval(loudnessInterval);
      loudnessInterval = null;
    }
    loudnessRmsHistory = [];
  }

  function startLoudnessMetering() {
    stopLoudnessMetering();
    if (!loudnessAnalyser) return;
    const buf = new Float32Array(loudnessAnalyser.fftSize);
    loudnessInterval = setInterval(() => {
      if (!loudnessAnalyser || !audioEl || audioEl.paused) return;
      loudnessAnalyser.getFloatTimeDomainData(buf);
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) sumSquares += buf[i] * buf[i];
      const meanSquare = sumSquares / buf.length;

      const now = performance.now();
      loudnessRmsHistory.push({ meanSquare, t: now });
      const cutoff = now - LOUDNESS_WINDOW_MS;
      while (loudnessRmsHistory.length && loudnessRmsHistory[0].t < cutoff) loudnessRmsHistory.shift();
      if (!loudnessRmsHistory.length) return;

      const avgMeanSquare =
        loudnessRmsHistory.reduce((sum, entry) => sum + entry.meanSquare, 0) / loudnessRmsHistory.length;
      if (avgMeanSquare <= 0) return; // silence, skip rather than feed -Infinity

      const lufs = -0.691 + 10 * Math.log10(avgMeanSquare); // BS.1770 loudness formula
      window.Musik?.gameDuck?.setTrackLoudness?.(lufs);
    }, LOUDNESS_TICK_MS);
  }

  async function loadTrack(track) {
    // track: { filePath, title, artist, album, duration, artData }
    createAudioGraph();
    currentTrack = track;
    window.Musik?.gameDuck?.setTrackLoudness?.(null); // clear old track's boost immediately

    // file: URL, no transcoding. encodeURI leaves # unescaped (valid URI char)
    // so it's replaced separately — # is common in real filenames.
    audioEl.src = 'file:///' + encodeURI(track.filePath.replace(/\\/g, '/')).replace(/#/g, '%23');

    window.Musik.events.push('trackupdate', track);
    if (track.artData) {
      window.Musik.events.push('artupdate', track.artData);
    }

    trackStartTimestamp = Math.floor(Date.now() / 1000);
    hasScrobbled = false;
    window.Musik.scrobble?.nowPlaying?.(track); // not awaited, shouldn't delay playback

    await audioEl.play();
    startLoudnessMetering();
  }

  async function playFiles(paths) {
    // Dialog allows files AND folders — try as file first, fall back to folder scan.
    const tracks = [];
    for (const p of paths) {
      const tags = await window.Musik.library.readTags(p);
      if (tags) {
        tracks.push(tags);
        continue;
      }

      // scanFolder() only returns NEWLY discovered tracks, so pull the
      // folder's full current list from the library instead of trusting
      // its return value alone (otherwise a previously-scanned folder
      // reports 0 tracks here).
      await window.Musik.library.scanFolder(p);
      const allTracks = await window.Musik.library.getTracks();
      const normalizedFolder = p.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      const inFolder = (allTracks || []).filter((t) =>
        t.filePath.replace(/\\/g, '/').startsWith(normalizedFolder)
      );
      if (inFolder.length) tracks.push(...inFolder);
    }
    if (!tracks.length) {
      console.warn('[Musik] playFiles: no playable tracks found in', paths);
      return;
    }

    for (const t of tracks) await window.Musik.queue.add(t);
    window.Musik.events.push('queueupdate');
    await loadTrack(tracks[0]);
  }

  async function playQueue(tracks, { shuffle: shouldShuffle = false } = {}) {
    if (!tracks || !tracks.length) return;

    await window.Musik.queue.clear();
    for (const t of tracks) await window.Musik.queue.add(t);
    await window.Musik.queue.shuffle(shouldShuffle); // only affects future next()/previous() order

    window.Musik.events.push('queueupdate');
    await loadTrack(tracks[0]);
  }

  function togglePlayPause() {
    if (!audioEl) return;
    if (audioEl.paused) audioEl.play();
    else audioEl.pause();
  }

  function seek(seconds) {
    if (audioEl) audioEl.currentTime = seconds;
  }

  function setVolume(value) {
    currentVolume = Math.max(0, Math.min(1, value));
    applyEffectiveVolume();
    // Mirrors the honest user-set volume (not duck-multiplied) into main's
    // AudioEngine state via the already-wired player:set-volume channel.
    // Previously never called — AudioEngine.state.volume sat permanently
    // stale at its 1.0 default. Fire-and-forget: nothing should block the
    // slider on an IPC round trip.
    window.Musik?.player?.setVolume?.(currentVolume);
  }

  async function next() {
    const nextTrack = await window.Musik.queue.next();
    if (nextTrack) await loadTrack(nextTrack);
  }

  async function previous() {
    const prevTrack = await window.Musik.queue.previous();
    if (prevTrack) await loadTrack(prevTrack);
  }

  // ASSUMPTION: window.Musik.queue.jumpTo(index) returns the track it
  // jumped to, same contract as .next()/.previous() above. If jumpTo
  // currently only moves the pointer and returns nothing/a boolean,
  // this needs a matching change wherever queue.jumpTo is implemented.
  async function jumpTo(index) {
    const track = await window.Musik.queue.jumpTo(index);
    if (track) await loadTrack(track);
  }

  // Game-reactive ducking — main process pushes the multiplier, applied on
  // top of currentVolume, never replacing it.
  window.Musik?.events?.on('duckupdate', ({ multiplier }) => {
    duckMultiplier = multiplier;
    applyEffectiveVolume();
  });

  // Ctrl+Shift+D: manual override toggle, not persisted, resets on relaunch.
  let manualOverrideActive = false;
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      manualOverrideActive = !manualOverrideActive;
      window.Musik?.gameDuck?.setManualOverride?.(manualOverrideActive);
      console.log(`[Musik] game duck manual override: ${manualOverrideActive ? 'ON (ducking disabled)' : 'off'}`);
    }
  });

  // Miniplayer has no audio graph of its own — commands relay here via main.js
  // and get executed against the real audioEl. This is the only place they run.
  window.Musik?.events?.on('miniplayer-command', ({ action, args }) => {
    switch (action) {
      case 'togglePlayPause': togglePlayPause(); break;
      case 'next': next(); break;
      case 'previous': previous(); break;
      case 'jumpTo': jumpTo(args?.index ?? 0); break;
      case 'seek': seek(args?.seconds ?? 0); break;
      case 'setVolume': setVolume(args?.value ?? currentVolume); break;
      default:
        console.warn('[Musik] unknown miniplayer command:', action);
    }
  });

  // "M" toggles miniplayer — guarded against firing while typing anywhere.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  const miniToggleBtn = document.getElementById('pb-miniplayer-toggle');

  function kickMiniToggleBtn() {
    if (!miniToggleBtn) return;
    miniToggleBtn.classList.remove('pb-mini-kick');
    void miniToggleBtn.offsetWidth; // force reflow so animation restarts on rapid re-triggers
    miniToggleBtn.classList.add('pb-mini-kick');
  }
  miniToggleBtn?.addEventListener('animationend', () => miniToggleBtn.classList.remove('pb-mini-kick'));

  async function toggleMiniplayer() {
    kickMiniToggleBtn();
    const open = await window.Musik.window.toggleMiniplayer();
    miniToggleBtn?.setAttribute('aria-pressed', String(!!open));
  }

  window.Musik?.events?.on('miniplayerchange', ({ open }) => {
    miniToggleBtn?.setAttribute('aria-pressed', String(!!open));
  });

  miniToggleBtn?.addEventListener('click', toggleMiniplayer);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.key.toLowerCase() === 'm') {
      toggleMiniplayer();
    }
  });

  // Answers a newly-opened miniplayer's request for current state (trackupdate
  // etc. only fire on the NEXT change, so without this it shows nothing until
  // the next track). push() reaches other windows, not just local listeners.
  window.Musik?.events?.on('request-state-sync', () => {
    if (!currentTrack) return;
    window.Musik.events.push('trackupdate', currentTrack);
    if (currentTrack.artData) window.Musik.events.push('artupdate', currentTrack.artData);
    window.Musik.events.push(audioEl && !audioEl.paused ? 'play' : 'pause', currentTrack);
    window.Musik.events.push('progress', {
      currentTime: audioEl?.currentTime ?? 0,
      duration: audioEl?.duration || currentTrack.duration || 0,
    });
    window.Musik.events.push('volumechange', {
      volume: currentVolume,
      effectiveVolume: audioEl?.volume ?? 1,
    });
  });

  window.MusikPlayerUI = {
    playFiles,
    playQueue,
    loadTrack,
    togglePlayPause,
    seek,
    setVolume,
    next,
    previous,
    jumpTo,
    getAnalyser: () => analyserNode, // future visualizer hook
    getEQNodes: () => eqNodes, // live BiquadFilterNode[10] — eq.js drives these directly
    getCurrentTime: () => audioEl?.currentTime ?? 0,
    getDuration: () => audioEl?.duration || (currentTrack?.duration ?? 0),
    getVolume: () => currentVolume,
    getEffectiveVolume: () => audioEl?.volume ?? 1, // includes duck multiplier, debug/meters only
    getCurrentLoudnessLufs: () => {
      if (!loudnessRmsHistory.length) return null;
      const avg = loudnessRmsHistory.reduce((sum, entry) => sum + entry.meanSquare, 0) / loudnessRmsHistory.length;
      return avg > 0 ? -0.691 + 10 * Math.log10(avg) : null;
    }, // rolling short-term estimate, debug/meters only
    isPaused: () => audioEl?.paused ?? true,
    getCurrentTrackData: () => currentTrack,
  };
})();
