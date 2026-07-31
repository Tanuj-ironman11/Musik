// src/core/stats.js
//
// Local play-tracking for the Profile tab. Main-process only, same pattern
// as scrobbler.js/game-duck.js: init(userDataPath) loads a JSON file from
// userData, persisted on every write.
//
// This is intentionally NOT a duplicate of Last.fm's qualifying logic —
// recordPlay() is called from the exact same trigger point in player-ui.js
// as scrobbler's submitScrobble(), so "a play" means one thing across the
// whole app. See player-ui.js's timeupdate listener (50% played or 4min,
// whichever first; <30s never qualifies).
//
// Runs ALWAYS, regardless of Last.fm connection state — this is what lets
// lifetime stats stay gapless if someone connects Last.fm a month after
// first launch. lastfmConnectedAt is the merge anchor the Profile tab view
// uses to decide which source (local tally vs Last.fm API) backs which time
// range; that merge logic lives in the renderer/profile view, not here.
// This module only ever reports its own local tally.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  totalPlays: 0,
  totalSeconds: 0, // sum of track.duration for every qualifying play
  perArtist: {},   // artist -> play count
  perAlbum: {},    // "artist::album" -> play count
  perTrack: {},    // "artist::title" -> play count
  firstTrackedAt: null, // unix ms, set on first-ever recordPlay
  lastfmConnectedAt: null, // unix ms, set once by markLastfmConnected()
};

let statsPath = null;
let lifetime = { ...DEFAULTS };

// Session stats are deliberately memory-only — resets every launch, never
// written to disk.
let session = {
  plays: 0,
  seconds: 0,
  startedAt: null,
};

function loadFromDisk() {
  if (!statsPath || !fs.existsSync(statsPath)) return;
  try {
    const disk = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    lifetime = { ...DEFAULTS, ...disk };
  } catch (err) {
    console.warn('[Musik] stats: failed to read stats.json, using defaults:', err.message);
  }
}

function saveToDisk() {
  if (!statsPath) return;
  try {
    fs.writeFileSync(statsPath, JSON.stringify(lifetime, null, 2));
  } catch (err) {
    console.warn('[Musik] stats: failed to save stats.json:', err.message);
  }
}

function init(userDataPath) {
  statsPath = path.join(userDataPath, 'stats.json');
  loadFromDisk();
  session = { plays: 0, seconds: 0, startedAt: Date.now() };
}

function bump(obj, key) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + 1;
}

// track: { title, artist, album, duration, filePath } — same shape passed
// to scrobbler.scrobble(). Called once per qualifying play, same call site.
function recordPlay(track) {
  if (!track?.title || !track?.artist) return null;

  const duration = Number(track.duration) || 0;
  const artistKey = track.artist;
  const albumKey = track.album ? `${track.artist}::${track.album}` : null;
  const trackKey = `${track.artist}::${track.title}`;

  // Session (memory-only)
  session.plays += 1;
  session.seconds += duration;

  // Lifetime (persisted)
  if (!lifetime.firstTrackedAt) lifetime.firstTrackedAt = Date.now();
  lifetime.totalPlays += 1;
  lifetime.totalSeconds += duration;
  bump(lifetime.perArtist, artistKey);
  if (albumKey) bump(lifetime.perAlbum, albumKey);
  bump(lifetime.perTrack, trackKey);
  saveToDisk();

  return { session: getSessionStats(), lifetime: getLifetimeStats() };
}

function topN(counts, n = 10) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function getSessionStats() {
  return {
    plays: session.plays,
    seconds: session.seconds,
    startedAt: session.startedAt,
  };
}

function getLifetimeStats() {
  return {
    totalPlays: lifetime.totalPlays,
    totalSeconds: lifetime.totalSeconds,
    topArtists: topN(lifetime.perArtist),
    topAlbums: topN(lifetime.perAlbum),
    topTracks: topN(lifetime.perTrack),
    firstTrackedAt: lifetime.firstTrackedAt,
    lastfmConnectedAt: lifetime.lastfmConnectedAt,
  };
}

// Called once, the moment a Last.fm connection first succeeds (see
// scrobble:complete-auth handler in main.js). Idempotent — only ever sets
// the anchor once, so reconnecting later doesn't reset the merge point and
// silently orphan the gap between original connect and reconnect.
function markLastfmConnected() {
  if (!lifetime.lastfmConnectedAt) {
    lifetime.lastfmConnectedAt = Date.now();
    saveToDisk();
  }
  return lifetime.lastfmConnectedAt;
}

module.exports = {
  init,
  recordPlay,
  getSessionStats,
  getLifetimeStats,
  markLastfmConnected,
};
