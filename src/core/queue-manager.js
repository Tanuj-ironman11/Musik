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

// Returns tracks in the order they'll actually play. When shuffle is off
// this is plain add-order. When shuffle is on, this now returns tracks in
// shuffled order (matching what next()/previous() will walk through)
// instead of raw add-order, so the queue panel and real playback line up.
function getQueue() {
  if (shuffleEnabled && shuffleOrder.length === queue.length) {
    return shuffleOrder.map((i) => ({ ...queue[i], queueIndex: i }));
  }
  return queue.map((t, i) => ({ ...t, queueIndex: i }));
}

function add(track) {
  queue.push(track);
  // If nothing was playing yet, treat the first added track as current so
  // next()/previous() have a sane starting point.
  if (currentIndex === -1) currentIndex = 0;
  if (shuffleEnabled) rebuildShuffleOrder(true);
  return getQueue();
}

function remove(index) {
  if (index < 0 || index >= queue.length) return getQueue();
  queue.splice(index, 1);
  if (index < currentIndex) {
    currentIndex -= 1;
  } else if (index === currentIndex) {
    // Keep pointing at "the track now at this index", clamped to bounds.
    currentIndex = Math.min(currentIndex, queue.length - 1);
  }
  if (shuffleEnabled) rebuildShuffleOrder(false);
  return getQueue();
}

function clear() {
  queue = [];
  currentIndex = -1;
  shuffleOrder = [];
  shufflePos = -1;
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

  if (repeatMode === 'one') {
    return queue[currentIndex] ?? null;
  }

  if (shuffleEnabled) {
    if (shufflePos === -1) rebuildShuffleOrder(true);
    shufflePos += 1;
    if (shufflePos >= shuffleOrder.length) {
      if (repeatMode === 'all') {
        rebuildShuffleOrder(false);
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
  if (shuffleEnabled) {
    const pos = shuffleOrder.indexOf(index);
    shufflePos = pos > -1 ? pos : 0;
  }
  return queue[currentIndex];
}

// Drag-reorder support. Moves the track at fromIndex to toIndex, keeping
// currentIndex pointed at the SAME TRACK (not the same position) — so
// reordering the queue never changes what's actually playing.
function move(fromIndex, toIndex) {
  if (
    fromIndex < 0 || fromIndex >= queue.length ||
    toIndex < 0 || toIndex >= queue.length ||
    fromIndex === toIndex
  ) {
    return getQueue();
  }

  const currentTrack = currentIndex !== -1 ? queue[currentIndex] : null;

  const [moved] = queue.splice(fromIndex, 1);
  queue.splice(toIndex, 0, moved);

  if (currentTrack) {
    currentIndex = queue.indexOf(currentTrack);
  }
  if (shuffleEnabled) rebuildShuffleOrder(true);

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
