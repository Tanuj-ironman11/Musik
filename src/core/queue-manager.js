// src/core/queue-manager.js
//
// Main-process queue state. In-memory only (no persistence yet). Backs the
// queue:* IPC handlers in main.js, which back window.Musik.queue in
// preload.js.

let queue = [];       // array of track objects (same shape as library.readTags output)
let currentIndex = -1; // index into queue of the currently loaded track
let shuffleEnabled = false;
let repeatMode = 'off'; // 'off' | 'all' | 'one'
let shuffleOrder = [];  // when shuffle is on, order of indices into `queue`
let shufflePos = -1;    // position within shuffleOrder
// The playing track was removed, so currentIndex now points at the track that
// slid into its slot (never played). next() must return that track as-is;
// advancing from it skipped a song every time you removed the current one.
let currentRemoved = false;

// Returns tracks in the order they'll actually play. When shuffle is off
// this is plain add-order. When shuffle is on, this now returns tracks in
// shuffled order (matching what next()/previous() will walk through)
// instead of raw add-order, so the queue panel and real playback line up.
function getQueue() {
  if (shuffleEnabled && shuffleOrder.length === queue.length) {
    return shuffleOrder.map((i) => ({ ...queue[i], queueIndex: i, isCurrent: i === currentIndex }));
  }
  return queue.map((t, i) => ({ ...t, queueIndex: i, isCurrent: i === currentIndex }));
}

function add(track) {
  queue.push(track);
  // If nothing was playing yet, treat the first added track as current so
  // next()/previous() have a sane starting point.
  if (currentIndex === -1) currentIndex = 0;
  if (shuffleEnabled) {
    if (shuffleOrder.length !== queue.length - 1) {
      rebuildShuffleOrder(true);
    } else {
      // Slot the new track into the not-yet-played part of the order instead
      // of reshuffling everything (that scrambled "up next" on every add).
      const lo = shufflePos + 1;
      const at = lo + Math.floor(Math.random() * (shuffleOrder.length - lo + 1));
      shuffleOrder.splice(at, 0, queue.length - 1);
      shufflePos = shuffleOrder.indexOf(currentIndex);
    }
  }
  return getQueue();
}

function remove(index) {
  if (index < 0 || index >= queue.length) return getQueue();
  const wasCurrent = index === currentIndex;
  const removedPos = shuffleEnabled ? shuffleOrder.indexOf(index) : -1;
  queue.splice(index, 1);

  if (shuffleEnabled) {
    // Drop the entry and re-map indices above it; every other track keeps
    // its shuffled position (a full rebuild re-randomized "up next" and
    // could put already-played tracks back in front).
    shuffleOrder = shuffleOrder.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
    if (removedPos > -1 && removedPos < shufflePos) shufflePos -= 1;
  }

  if (!queue.length) {
    currentIndex = -1;
    shufflePos = -1;
    currentRemoved = false;
    return getQueue();
  }

  if (wasCurrent) {
    if (shuffleEnabled) {
      if (shufflePos < shuffleOrder.length) {
        currentIndex = shuffleOrder[shufflePos]; // next track in shuffle order slid in
        currentRemoved = true;
      } else {
        shufflePos = shuffleOrder.length - 1;    // removed the last one — nothing slid in
        currentIndex = shuffleOrder[shufflePos];
        currentRemoved = false;
      }
    } else if (index < queue.length) {
      currentIndex = index;                      // next track slid into the slot
      currentRemoved = true;
    } else {
      currentIndex = queue.length - 1;           // removed the last one — nothing slid in
      currentRemoved = false;
    }
  } else if (index < currentIndex) {
    currentIndex -= 1;
  }
  return getQueue();
}

function clear() {
  queue = [];
  currentIndex = -1;
  shuffleOrder = [];
  shufflePos = -1;
  currentRemoved = false;
  return getQueue();
}

function rebuildShuffleOrder(keepCurrentFirst) {
  const indices = queue.map((_, i) => i);
  // Fisher-Yates
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  if (keepCurrentFirst && currentIndex !== -1) {
    const pos = indices.indexOf(currentIndex);
    if (pos > -1) {
      indices.splice(pos, 1);
      indices.unshift(currentIndex);
    }
  }
  shuffleOrder = indices;
  shufflePos = shuffleOrder.indexOf(currentIndex);
}

function next() {
  if (!queue.length) return null;

  if (currentRemoved) {
    currentRemoved = false;
    return queue[currentIndex] ?? null;
  }

  if (repeatMode === 'one') {
    return queue[currentIndex] ?? null;
  }

  if (shuffleEnabled) {
    if (shufflePos === -1) rebuildShuffleOrder(true);
    shufflePos += 1;
    if (shufflePos >= shuffleOrder.length) {
      if (repeatMode === 'all') {
        rebuildShuffleOrder(false);
        // Don't open the new lap with the track that just finished.
        if (shuffleOrder.length > 1 && shuffleOrder[0] === currentIndex) {
          const swap = 1 + Math.floor(Math.random() * (shuffleOrder.length - 1));
          [shuffleOrder[0], shuffleOrder[swap]] = [shuffleOrder[swap], shuffleOrder[0]];
        }
        shufflePos = 0;
      } else {
        shufflePos = shuffleOrder.length - 1;
        return null; // end of queue
      }
    }
    currentIndex = shuffleOrder[shufflePos];
    return queue[currentIndex] ?? null;
  }

  if (currentIndex + 1 < queue.length) {
    currentIndex += 1;
    return queue[currentIndex];
  }
  if (repeatMode === 'all' && queue.length) {
    currentIndex = 0;
    return queue[currentIndex];
  }
  return null; // end of queue, nothing to advance to
}

function previous() {
  if (!queue.length) return null;
  currentRemoved = false;

  if (repeatMode === 'one') {
    return queue[currentIndex] ?? null;
  }

  if (shuffleEnabled) {
    if (shufflePos <= 0) return queue[currentIndex] ?? null;
    shufflePos -= 1;
    currentIndex = shuffleOrder[shufflePos];
    return queue[currentIndex] ?? null;
  }

  if (currentIndex - 1 >= 0) {
    currentIndex -= 1;
    return queue[currentIndex];
  }
  if (repeatMode === 'all' && queue.length) {
    currentIndex = queue.length - 1;
    return queue[currentIndex];
  }
  return null;
}

function jumpTo(index) {
  if (index < 0 || index >= queue.length) return null;
  currentIndex = index;
  currentRemoved = false;
  if (shuffleEnabled) {
    const pos = shuffleOrder.indexOf(index);
    shufflePos = pos > -1 ? pos : 0;
  }
  return queue[currentIndex];
}

// Drag-reorder support. Moves the track at fromIndex to toIndex, keeping
// currentIndex pointed at the SAME TRACK (not the same position) — so
// reordering the queue never changes what's actually playing.
// Both indices are queue indices (what getQueue() calls queueIndex). With
// shuffle on, the panel shows shuffleOrder, so the move happens there —
// reordering the raw queue and then rebuilding the shuffle threw away
// whatever the user just arranged.
function move(fromIndex, toIndex) {
  if (
    fromIndex < 0 || fromIndex >= queue.length ||
    toIndex < 0 || toIndex >= queue.length ||
    fromIndex === toIndex
  ) {
    return getQueue();
  }

  if (shuffleEnabled) {
    const fromPos = shuffleOrder.indexOf(fromIndex);
    const toPos = shuffleOrder.indexOf(toIndex);
    if (fromPos === -1 || toPos === -1 || fromPos === toPos) return getQueue();
    const [m] = shuffleOrder.splice(fromPos, 1);
    shuffleOrder.splice(toPos, 0, m);
    shufflePos = shuffleOrder.indexOf(currentIndex);
    return getQueue();
  }

  const [moved] = queue.splice(fromIndex, 1);
  queue.splice(toIndex, 0, moved);

  // Follow the current track by index math — queue.indexOf(track) breaks
  // when the same track object is in the queue twice.
  if (currentIndex === fromIndex) currentIndex = toIndex;
  else if (fromIndex < currentIndex && currentIndex <= toIndex) currentIndex -= 1;
  else if (toIndex <= currentIndex && currentIndex < fromIndex) currentIndex += 1;

  return getQueue();
}

function shuffle(enabled) {
  shuffleEnabled = !!enabled;
  if (shuffleEnabled) {
    rebuildShuffleOrder(true);
  } else {
    shuffleOrder = [];
    shufflePos = -1;
  }
  return shuffleEnabled;
}

function setRepeatMode(mode) {
  if (['off', 'all', 'one'].includes(mode)) repeatMode = mode;
  return repeatMode;
}

module.exports = {
  getQueue,
  add,
  remove,
  clear,
  next,
  previous,
  jumpTo,
  move,
  shuffle,
  setRepeatMode,
};
