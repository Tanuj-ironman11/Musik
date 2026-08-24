// src/ui/player-bar.js
// Now-playing bar: click-to-seek, keyboard hotkeys. Markup is unstyled;
// visual treatment lives in CSS.

(function () {
  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function init() {
    const bar = document.getElementById('now-playing-bar');
    if (!bar) {
      console.error('[Musik] #now-playing-bar not found in DOM');
      return;
    }

    bar.innerHTML = `
      <div id="player-bar">
      <div class="pb-track-info">
        <div class="pb-art-wrap">
          <div id="pb-art" class="pb-art--placeholder">
            <svg class="placeholder-note-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
          </div>
          <div class="pb-fullscreen-btn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
          </div>
        </div>
        <div class="pb-text">
          <span id="pb-title" class="pb-title marquee">No track loaded</span>
          <span id="pb-artist" class="pb-artist marquee"></span>
        </div>
      </div>
      <div class="pb-center">
        <div class="pb-controls">
          <button id="pb-prev" class="pb-btn" title="Previous">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linejoin="round">
              <rect x="5.5" y="5" width="2.4" height="14" rx="1.2"/>
              <path d="M18.5 6.3v11.4a1 1 0 01-1.53.85l-8.6-5.7a1 1 0 010-1.7l8.6-5.7a1 1 0 011.53.85z" stroke-linecap="round"/>
            </svg>
          </button>
          <button id="pb-play-pause" class="pb-btn-play" title="Play">
            <svg class="pb-icon-play" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" stroke-linecap="round">
              <path d="M8.5 5.6a1 1 0 011.53-.85l9 6.4a1 1 0 010 1.7l-9 6.4A1 1 0 018.5 18.4z"/>
            </svg>
            <svg class="pb-icon-pause" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6.3" y="5" width="3.6" height="14" rx="1.6"/>
              <rect x="14.1" y="5" width="3.6" height="14" rx="1.6"/>
            </svg>
          </button>
          <button id="pb-next" class="pb-btn" title="Next">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linejoin="round">
              <rect x="16.1" y="5" width="2.4" height="14" rx="1.2"/>
              <path d="M5.5 6.3v11.4a1 1 0 001.53.85l8.6-5.7a1 1 0 000-1.7l-8.6-5.7a1 1 0 00-1.53.85z" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div class="pb-progress-row">
          <span id="pb-current-time" class="pb-time">0:00</span>
          <input id="pb-seek" class="pb-progress" type="range" min="0" max="100" step="0.1" value="0" />
          <span id="pb-duration" class="pb-time">0:00</span>
        </div>
      </div>
      <div class="pb-right">
        <button id="pb-queue-toggle" class="pb-btn" title="Queue">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path class="q-line q-line-1" d="M4 6h16"/>
            <path class="q-line q-line-2" d="M4 12h10"/>
            <path class="q-line q-line-3" d="M4 18h10"/>
            <path class="q-arrow" d="M18 15l3 3-3 3"/>
          </svg>
        </button>
        <span class="pb-volume-label">VOL</span>
        <input id="pb-volume-slider" class="pb-progress pb-volume-slider" type="range" min="0" max="1" step="0.01" value="1" />
      </div>
      </div>
    `;

    const els = {
      title: document.getElementById('pb-title'),
      artist: document.getElementById('pb-artist'),
      art: document.getElementById('pb-art'),
      playPause: document.getElementById('pb-play-pause'),
      prev: document.getElementById('pb-prev'),
      next: document.getElementById('pb-next'),
      currentTime: document.getElementById('pb-current-time'),
      duration: document.getElementById('pb-duration'),
      seek: document.getElementById('pb-seek'),
      volume: document.getElementById('pb-volume-slider'),
    };

    function setPlayIcon(isPlaying) {
      els.playPause.classList.toggle('is-playing', isPlaying);
      els.playPause.title = isPlaying ? 'Pause' : 'Play';
    }

    function setArt(track) {
      const hasArt = track?.artData?.base64;
      if (hasArt) {
        els.art.classList.remove('pb-art--placeholder');
        els.art.innerHTML = `<img class="pb-art" src="data:image/${track.artData.format || 'jpeg'};base64,${track.artData.base64}" alt="">`;
      } else {
        els.art.classList.add('pb-art--placeholder');
        els.art.innerHTML = `<svg class="placeholder-note-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;
      }
    }

    let userIsSeeking = false;

    function spawnRipple(btn, evt) {
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 1.9;
      const ripple = document.createElement('span');
      ripple.className = 'pb-ripple';
      const originX = (evt?.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
      const originY = (evt?.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${originX}px`;
      ripple.style.top = `${originY}px`;
      btn.appendChild(ripple);

      const anim = ripple.animate(
        [
          { transform: 'scale(0)', opacity: 0.5 },
          { transform: 'scale(1)', opacity: 0 },
        ],
        { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
      anim.onfinish = () => ripple.remove();
    }

    function spawnCarouselKick(btn, direction) {
      const svg = btn.querySelector('svg');
      if (!svg) return;
      svg.getAnimations().forEach((a) => a.cancel());
      const dist = btn.getBoundingClientRect().width * 1.4;
      const spring =
        getComputedStyle(document.documentElement).getPropertyValue('--ease-bounce').trim() ||
        'cubic-bezier(0.34, 1.56, 0.64, 1)';
      svg.animate(
        [
          { transform: 'translateX(0)', opacity: 1, offset: 0 },
          { transform: `translateX(${direction * dist}px)`, opacity: 0, offset: 0.45 },
          { transform: `translateX(${-direction * dist}px)`, opacity: 0, offset: 0.46 },
          { transform: 'translateX(0)', opacity: 1, offset: 1 },
        ],
        { duration: 340, easing: spring }
      );
    }

    els.playPause.addEventListener('click', (e) => {
      spawnRipple(els.playPause, e);
      window.MusikPlayerUI?.togglePlayPause();
    });

    document.querySelector('.pb-fullscreen-btn')?.addEventListener('click', () => {
      window.MusikNowPlayingFullscreen?.open();
    });
    document.querySelector('.pb-art-wrap')?.addEventListener('dblclick', () => {
      window.MusikNowPlayingFullscreen?.open();
    });

    els.prev.addEventListener('click', (e) => {
      spawnRipple(els.prev, e);
      spawnCarouselKick(els.prev, -1);
      window.MusikPlayerUI?.previous();
    });
    els.next.addEventListener('click', (e) => {
      spawnRipple(els.next, e);
      spawnCarouselKick(els.next, 1);
      window.MusikPlayerUI?.next();
    });

    const queueBtn = document.getElementById('pb-queue-toggle');
    let queueKickTimer = null;
    function spawnQueuePop(btn) {
      btn.classList.remove('pb-queue-kick');
      void btn.offsetWidth;
      btn.classList.add('pb-queue-kick');
      clearTimeout(queueKickTimer);
      queueKickTimer = setTimeout(() => btn.classList.remove('pb-queue-kick'), 560);
    }
    queueBtn?.addEventListener('click', (e) => {
      spawnRipple(e.currentTarget, e);
      spawnQueuePop(e.currentTarget);
      window.MusikQueuePanel?.toggle();
      const isOpen = window.MusikQueuePanel?.isOpen?.();
      if (isOpen !== undefined) {
        queueBtn.setAttribute('aria-pressed', String(isOpen));
      } else {
        const wasPressed = queueBtn.getAttribute('aria-pressed') === 'true';
        queueBtn.setAttribute('aria-pressed', String(!wasPressed));
      }
    });

    function updateSeekFill() {
      const pct = els.seek.max > 0 ? (Number(els.seek.value) / Number(els.seek.max)) * 100 : 0;
      els.seek.style.setProperty('--progress', `${pct}%`);
    }

    function updateVolumeFill() {
      const max = Number(els.volume.max) || 1;
      const pct = (Number(els.volume.value) / max) * 100;
      els.volume.style.setProperty('--progress', `${pct}%`);
    }

    els.seek.addEventListener('mousedown', (e) => {
      const rect = els.seek.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetTime = pct * (Number(els.seek.max) || 0);

      els.seek.value = targetTime;
      updateSeekFill();
      els.currentTime.textContent = fmtTime(targetTime);
      window.MusikPlayerUI?.seek?.(targetTime);
    });

    els.seek.addEventListener('input', () => {
      userIsSeeking = true;
      els.currentTime.textContent = fmtTime(Number(els.seek.value));
      updateSeekFill();
    });
    els.seek.addEventListener('change', () => {
      window.MusikPlayerUI?.seek(Number(els.seek.value));
      userIsSeeking = false;
    });

    els.volume.addEventListener('input', () => {
      window.MusikPlayerUI?.setVolume(Number(els.volume.value));
      updateVolumeFill();
    });

    function seekDelta(seconds) {
      if (!window.MusikPlayerUI) return;
      const currentVal = Number(els.seek.value);
      const maxVal = Number(els.seek.max) || 0;
      const newVal = Math.max(0, Math.min(maxVal, currentVal + seconds));

      els.seek.value = newVal;
      updateSeekFill();
      els.currentTime.textContent = fmtTime(newVal);
      window.MusikPlayerUI.seek?.(newVal);
    }

    function adjustVolume(delta) {
      const currentVal = Number(els.volume.value);
      const newVal = Math.max(0, Math.min(1, currentVal + delta));

      els.volume.value = newVal;
      updateVolumeFill();
      window.MusikPlayerUI?.setVolume?.(newVal);
    }

    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
         active.tagName === 'TEXTAREA' ||
         active.isContentEditable)
      ) {
        return;
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          els.playPause.click();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) els.prev.click();
          else seekDelta(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) els.next.click();
          else seekDelta(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustVolume(0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.05);
          break;
        case 'MediaPlayPause':
          e.preventDefault();
          els.playPause.click();
          break;
        case 'MediaTrackNext':
          e.preventDefault();
          els.next.click();
          break;
        case 'MediaTrackPrevious':
          e.preventDefault();
          els.prev.click();
          break;
        default:
          break;
      }
    });

    window.Musik.events.on('trackupdate', (track) => {
      if (!track) return;
      els.title.textContent = track.title ?? 'Unknown Title';
      els.artist.textContent = track.artist ?? 'Unknown Artist';
      window.MusikMarquee?.refresh(els.title);
      window.MusikMarquee?.refresh(els.artist);
      els.seek.max = track.duration || 0;
      els.duration.textContent = fmtTime(track.duration || 0);
      setArt(track);
    });

    window.Musik.events.on('progress', ({ currentTime, duration }) => {
      if (userIsSeeking) return;
      els.seek.max = duration || els.seek.max;
      els.seek.value = currentTime;
      els.currentTime.textContent = fmtTime(currentTime);
      els.duration.textContent = fmtTime(duration);
      updateSeekFill();
    });

    window.Musik.events.on('play', () => {
      setPlayIcon(true);
    });
    window.Musik.events.on('pause', () => {
      setPlayIcon(false);
    });

    if (window.MusikPlayerUI) {
      const current = window.MusikPlayerUI.getCurrentTrackData?.();
      if (current) {
        els.title.textContent = current.title ?? 'Unknown Title';
        els.artist.textContent = current.artist ?? 'Unknown Artist';
        window.MusikMarquee?.refresh(els.title);
        window.MusikMarquee?.refresh(els.artist);
        setArt(current);
      }
      els.volume.value = window.MusikPlayerUI.getVolume?.() ?? 1;
      setPlayIcon(!window.MusikPlayerUI.isPaused?.());
    }
    const queueOpenNow = window.MusikQueuePanel?.isOpen?.();
    if (queueOpenNow !== undefined) {
      document.getElementById('pb-queue-toggle')?.setAttribute('aria-pressed', String(queueOpenNow));
    }
    updateVolumeFill();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
