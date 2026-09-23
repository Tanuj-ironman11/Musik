// src/ui/miniplayer-ui.js
// Renderer for the miniplayer window only. No audio graph here — commands
// go out via window.Musik.miniplayer.command(), which main.js relays to
// player-ui.js in the main window. player-ui.js broadcasts trackupdate/
// play/pause/progress/volumechange/queueupdate via push() specifically so
// this window stays live without needing to be reopened.

(function () {
  const root = document.getElementById('mp-root');
  const artEl = document.getElementById('mp-art');
  const artPlaceholder = document.getElementById('mp-art-placeholder');
  const titleEl = document.getElementById('mp-title');
  const artistEl = document.getElementById('mp-artist');
  const playPauseBtn = document.getElementById('mp-playpause');
  const progressEl = document.getElementById('mp-progress');
  const queueToggleBtn = document.getElementById('pb-queue-toggle');
  const queuePanel = document.getElementById('mp-queue-panel');
  const queueList = document.getElementById('mp-queue-list');

  let queueOpen = false;
  let knownDuration = 0;
  let currentFilePath = null;

  function command(action, args) {
    window.Musik.miniplayer.command(action, args);
  }

  const prevBtn = document.getElementById('mp-prev');
  const nextBtn = document.getElementById('mp-next');

  // Ported from player-bar.js's spawnCarouselKick — the miniplayer never
  // had this wired up, which is why only play/queue animated before.
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

  prevBtn.addEventListener('click', () => {
    spawnCarouselKick(prevBtn, -1);
    command('previous');
  });
  nextBtn.addEventListener('click', () => {
    spawnCarouselKick(nextBtn, 1);
    command('next');
  });
  playPauseBtn.addEventListener('click', () => command('togglePlayPause'));

  // --- Layout: controls/progress are never hidden. Art hides below a
  // HEIGHT threshold (it's the thing competing with controls for vertical
  // space); title/artist hide below a WIDTH threshold (they're the thing
  // competing for horizontal space when the window's thin). -------------
  function updateLayout(width, height) {
    // Wide banner (ratio >= 1.75) OR slim window (height <= 170) -> Horizontal
    // Square or tall window -> Vertical Card
    const isHorizontal = !queueOpen && ((width / height >= 1.75) || height <= 170);
    root.classList.toggle('mp-horizontal', isHorizontal);
    root.classList.toggle('mp-no-art', !isHorizontal && height < 120);
    root.classList.toggle('mp-no-text', isHorizontal && width < 240);
  }

  new ResizeObserver((entries) => {
    for (const entry of entries) updateLayout(entry.contentRect.width, entry.contentRect.height);
  }).observe(document.body);

  // --- Queue popup: grows the actual window rather than overlaying -------
  async function renderQueue() {
    const tracks = await window.Musik.queue.getQueue();
    queueList.innerHTML = '';
    if (!tracks || !tracks.length) {
      const li = document.createElement('li');
      li.className = 'mp-queue-empty';
      li.textContent = 'Queue is empty';
      queueList.appendChild(li);
      return;
    }
    tracks.forEach((track, index) => {
      const li = document.createElement('li');
      li.className = 'mp-queue-item';
      if (currentFilePath && track.filePath === currentFilePath) {
        li.classList.add('mp-queue-item--active');
      }

      // Drag handle — six-dot grip, drag-and-drop replaces the old
      // up/down arrow buttons for reordering.
      const handle = document.createElement('span');
      handle.className = 'mp-queue-item-handle';
      handle.setAttribute('aria-label', 'Drag to reorder');
      handle.innerHTML =
        '<svg viewBox="0 0 12 12" fill="currentColor">' +
        '<circle cx="3" cy="2.5" r="1.1"/><circle cx="9" cy="2.5" r="1.1"/>' +
        '<circle cx="3" cy="6" r="1.1"/><circle cx="9" cy="6" r="1.1"/>' +
        '<circle cx="3" cy="9.5" r="1.1"/><circle cx="9" cy="9.5" r="1.1"/>' +
        '</svg>';
      li.appendChild(handle);

      const label = document.createElement('span');
      label.className = 'mp-queue-item-label';
      label.textContent = track.title || track.filePath;
      // Was window.Musik.queue.jumpTo(index) directly — that only moves the
      // queue's internal pointer, nothing tells player-ui.js to actually
      // load the resulting track (compare next()/previous(), which both
      // call loadTrack() after moving the pointer). Routing through the
      // same command relay next/prev already use fixes that.
      label.addEventListener('click', () => command('jumpTo', { index }));
      li.appendChild(label);

      const actions = document.createElement('span');
      actions.className = 'mp-queue-item-actions';

      // NEW queue API surface — window.Musik.queue.reorder/remove don't
      // exist yet. Flagging per the "API changes called out before
      // implementation" rule: needs a main-process/queue-manager.js
      // handler for each, then exposing on preload.js the same way
      // getQueue/jumpTo/add/clear/shuffle already are.
      const removeBtn = document.createElement('button');
      removeBtn.className = 'mp-queue-item-btn mp-queue-item-btn--remove';
      removeBtn.setAttribute('aria-label', 'Remove from queue');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.Musik.queue.remove?.(index).then(renderQueue);
      });

      actions.append(removeBtn);
      li.appendChild(actions);

      // li is draggable so the browser gives us real drag feedback, but
      // dragstart bails unless it began on the handle — otherwise clicking
      // the label to jump to a track would sometimes start a drag instead.
      li.draggable = true;
      li.dataset.index = String(index);

      li.addEventListener('dragstart', (e) => {
        if (!e.target.closest('.mp-queue-item-handle')) {
          e.preventDefault();
          return;
        }
        dragSrcIndex = index;
        li.classList.add('mp-queue-item--dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index)); // Firefox needs a data payload to allow the drag
      });

      li.addEventListener('dragend', () => {
        li.classList.remove('mp-queue-item--dragging');
        clearDropIndicators();
        dragSrcIndex = null;
      });

      li.addEventListener('dragover', (e) => {
        if (dragSrcIndex === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const before = isBeforeMidpoint(li, e.clientY);
        li.classList.toggle('mp-queue-item--drop-before', before);
        li.classList.toggle('mp-queue-item--drop-after', !before);
      });

      li.addEventListener('dragleave', () => {
        li.classList.remove('mp-queue-item--drop-before', 'mp-queue-item--drop-after');
      });

      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const before = isBeforeMidpoint(li, e.clientY);
        clearDropIndicators();
        if (dragSrcIndex === null || dragSrcIndex === index) return;

        let targetIndex = before ? index : index + 1;
        // Removing the dragged item first shifts everything after it down
        // by one, so a target index past the source needs adjusting.
        if (dragSrcIndex < targetIndex) targetIndex -= 1;
        if (targetIndex === dragSrcIndex) return;

        window.Musik.queue.reorder?.(dragSrcIndex, targetIndex).then(renderQueue);
        dragSrcIndex = null;
      });

      queueList.appendChild(li);
    });
  }

  let dragSrcIndex = null;

  function isBeforeMidpoint(li, clientY) {
    const rect = li.getBoundingClientRect();
    return clientY - rect.top < rect.height / 2;
  }

  function clearDropIndicators() {
    queueList
      .querySelectorAll('.mp-queue-item--drop-before, .mp-queue-item--drop-after')
      .forEach((el) => el.classList.remove('mp-queue-item--drop-before', 'mp-queue-item--drop-after'));
  }

  function kickQueueBtn() {
    queueToggleBtn.classList.remove('pb-queue-kick');
    void queueToggleBtn.offsetWidth; // force reflow so it can re-trigger on rapid clicks
    queueToggleBtn.classList.add('pb-queue-kick');
  }
  queueToggleBtn.addEventListener('animationend', (e) => {
    if (e.target === queueToggleBtn || queueToggleBtn.contains(e.target)) {
      queueToggleBtn.classList.remove('pb-queue-kick');
    }
  });

  async function toggleQueue() {
    kickQueueBtn();
    queueOpen = !queueOpen;
    root.classList.toggle('mp-has-queue', queueOpen);
    queueToggleBtn.setAttribute('aria-pressed', String(queueOpen));
    queuePanel.hidden = !queueOpen;
    if (queueOpen) await renderQueue();
    await window.Musik.miniplayer.resizeForQueue(queueOpen);
  }
  queueToggleBtn.addEventListener('click', toggleQueue);

  window.Musik.events.on('queueupdate', () => {
    if (queueOpen) renderQueue();
  });

  // --- State from the main window (all pushed, so this fires live) -------
  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  const timeCurrentEl = document.getElementById('mp-time-current');
  const timeDurationEl = document.getElementById('mp-time-duration');

  window.Musik.events.on('trackupdate', (track) => {
    titleEl.textContent = track?.title || 'Nothing playing';
    artistEl.textContent = track?.artist || '';
    knownDuration = track?.duration || 0;
    if (timeDurationEl) timeDurationEl.textContent = fmtTime(knownDuration);
    if (timeCurrentEl) timeCurrentEl.textContent = '0:00';
    progressEl.value = 0;
    progressEl.max = knownDuration || 100;
    progressEl.style.setProperty('--progress', '0%');
    currentFilePath = track?.filePath || null;
    if (queueOpen) renderQueue();
  });

  window.Musik.events.on('artupdate', (artData) => {
    if (artData?.base64 && artData?.format) {
      artEl.src = `data:${artData.format};base64,${artData.base64}`;
      artEl.hidden = false;
      artPlaceholder.hidden = true;
    } else {
      artEl.hidden = true;
      artPlaceholder.hidden = false;
    }
  });

  window.Musik.events.on('play', () => playPauseBtn.classList.add('is-playing'));
  window.Musik.events.on('pause', () => playPauseBtn.classList.remove('is-playing'));

  let userIsScrubbing = false;

  function syncProgress(current, total) {
    const dur = Math.max(Math.round(total || 0), 1);
    const cur = Math.max(0, Math.min(Math.round(current || 0), dur));
    progressEl.max = dur;
    progressEl.value = cur;
    const pct = (cur / dur) * 100;
    progressEl.style.setProperty('--progress', `${pct}%`);
    if (timeCurrentEl) timeCurrentEl.textContent = fmtTime(cur);
    if (timeDurationEl && total) timeDurationEl.textContent = fmtTime(dur);
  }

  progressEl.addEventListener('input', () => {
    userIsScrubbing = true;
    const val = Number(progressEl.value);
    const max = Number(progressEl.max) || 1;
    const pct = (val / max) * 100;
    progressEl.style.setProperty('--progress', `${pct}%`);
    if (timeCurrentEl) timeCurrentEl.textContent = fmtTime(val);
  });

  progressEl.addEventListener('change', () => {
    command('seek', { seconds: Number(progressEl.value) });
    userIsScrubbing = false;
  });

  window.Musik.events.on('progress', ({ currentTime, duration }) => {
    if (duration) knownDuration = duration;
    if (userIsScrubbing || !knownDuration) return;
    syncProgress(currentTime, knownDuration);
  });

  // Ask the main window what's already playing, since we missed any
  // trackupdate/play events that fired before this window opened.
  window.Musik.events.push('request-state-sync', {});
})();
