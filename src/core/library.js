// src/core/library.js
//
// In-memory track list + tag reading via music-metadata. Folder scans are
// recursive: every folder that directly contains audio files becomes a
// playlist named after that folder ("folder = playlist" behavior).
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

// music-metadata v8+ ships as an ES Module — can't use require() from this
// CommonJS file. Cache the dynamic import so we only pay the cost once.
let mmPromise = null;
function getMM() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}
let watchedFolders = []; // top-level folder paths the user has explicitly scanned

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.wav', '.aiff', '.ogg', '.opus', '.aac', '.m4a', '.alac',
]);

// Yield to the event loop every N files so a big scan never blocks the
// main process (IPC, playback, window redraws) for its whole duration.
const YIELD_EVERY = 20;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

let tracks = [];
let playlists = [];
let rescanIntervalMinutes = 60; // 0 = disabled; user-adjustable via Settings

// Folder paths deleted via deletePlaylist since the process started. Exists
// to catch a real race: the 3s-after-launch auto-rescan (and the periodic
// one) call scanFolder(folderPath) which, at the end of its async walk,
// does playlists.find(...) || create-new — with zero awareness of anything
// that happened while it was mid-walk. Delete a folder-playlist while its
// own scan is still in flight (very reachable: click in, view, delete, all
// within a few seconds of launch) and the scan finishes afterward, finds
// no matching playlist, and recreates it. Each entry here is consumed
// (deleted) the first time a scan would've recreated that folder's
// playlist, so it only swallows the one resurrection attempt — a genuine
// later re-scan/re-import of the same folder works normally afterward.
let recentlyDeletedFolderPaths = new Set();

// ── Persistence ────────────────────────────────────────────────────
let storagePath = null;
let saveScheduled = false;
let saveTimer = null;

function init(userDataPath) {
  storagePath = path.join(userDataPath, 'musik-library.json');
  load();
}

function load() {
  if (!storagePath) return;
  try {
    if (fs.existsSync(storagePath)) {
      const raw = fs.readFileSync(storagePath, 'utf-8');
      const data = JSON.parse(raw);
      tracks = Array.isArray(data.tracks) ? data.tracks : [];
      playlists = Array.isArray(data.playlists) ? data.playlists : [];
      watchedFolders = Array.isArray(data.watchedFolders) ? data.watchedFolders : [];
      if (Number.isFinite(data.rescanIntervalMinutes) && data.rescanIntervalMinutes >= 0) {
        rescanIntervalMinutes = data.rescanIntervalMinutes;
      }

      let migrated = false;
      for (const p of playlists) {
        if (!p.id) {
          p.id = crypto.randomUUID();
          migrated = true;
        }
      }
      if (migrated) scheduleSave();
    }
  } catch (err) {
    console.warn('[Musik] library: failed to load persisted library:', err.message);
  }
}

function save() {
  if (!storagePath) return;
  try {
    fs.writeFileSync(storagePath, JSON.stringify({ tracks, playlists, watchedFolders, rescanIntervalMinutes }));
  } catch (err) {
    console.warn('[Musik] library: failed to save library:', err.message);
  }
}

// Debounced so a big folder scan (hundreds of tracks, each mutating
// playlists/tracks as it goes) doesn't trigger hundreds of synchronous
// writes — just one, shortly after the scan settles.
function scheduleSave() {
  if (saveScheduled) return;
  saveScheduled = true;
  saveTimer = setTimeout(() => {
    saveScheduled = false;
    saveTimer = null;
    save();
  }, 500);
}

// Cancels any pending debounced save and writes immediately. Exported so
// main.js can call it from a before-quit/window-all-closed handler — a
// scan that's mid-debounce when the app closes loses its last 500ms of
// writes otherwise. FLAGGED: this is a new required call on main.js's
// side, same as init() was; nothing here runs it automatically.
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveScheduled = false;
  save();
}

async function readTags(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const found = await scanFolder(filePath);
      return found[0] ?? null;
    }

    const mm = await getMM();
    const buffer = await fsp.readFile(filePath);
    const metadata = await mm.parseBuffer(buffer, undefined, { duration: true });
    const picture = metadata.common.picture?.[0];
    return {
      filePath,
      title: metadata.common.title ?? path.basename(filePath),
      artist: metadata.common.artist ?? 'Unknown Artist',
      album: metadata.common.album ?? 'Unknown Album',
      duration: metadata.format.duration ?? 0,
      addedAt: Date.now(),
      lastPlayedAt: null,
      artData: picture
        ? { format: picture.format, base64: Buffer.from(picture.data).toString('base64') }
        : null,
    };
  } catch (err) {
    console.warn(`[Musik] readTags failed for ${filePath}:`, err.message);
    return null;
  }
}

function markPlayed(filePath) {
  const track = tracks.find((t) => t.filePath === filePath);
  if (track) {
    track.lastPlayedAt = Date.now();
    scheduleSave();
  }
  return track ?? null;
}

async function scanFolder(folderPath) {
  console.log(`[Musik] scanFolder: starting scan of "${folderPath}"`);

  const allFound = [];
  let sinceYield = 0;
  const knownPaths = new Set(tracks.map((t) => t.filePath));

  if (!watchedFolders.includes(folderPath)) {
    watchedFolders.push(folderPath);
  }

  async function walk(dirPath) {
    let entries;
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      console.warn(`[Musik] scanFolder: failed to read ${dirPath}:`, err.message);
      return;
    }

    const directTrackPaths = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;

      if (knownPaths.has(fullPath)) {
        directTrackPaths.push(fullPath);
        continue;
      }

      const tags = await readTags(fullPath);
      sinceYield += 1;
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
      if (!tags) continue;

      allFound.push(tags);
      knownPaths.add(fullPath);
      directTrackPaths.push(fullPath);
    }

    if (directTrackPaths.length) {
      if (recentlyDeletedFolderPaths.has(dirPath)) {
        // Swallow exactly one resurrection attempt — see the Set's
        // declaration comment above. Track files themselves are still
        // added to `tracks` below (they're real files on disk); only the
        // playlist recreation for this specific folder is skipped.
        recentlyDeletedFolderPaths.delete(dirPath);
      } else {
        let playlist = playlists.find((p) => p.folderPath === dirPath);
        if (!playlist) {
          playlist = {
            id: crypto.randomUUID(),
            name: path.basename(dirPath),
            folderPath: dirPath,
            trackIds: [],
          };
          playlists.push(playlist);
        }
        for (const fp of directTrackPaths) {
          if (!playlist.trackIds.includes(fp)) playlist.trackIds.push(fp);
        }
      }
    }
  }

  await walk(folderPath);

  console.log(`[Musik] scanFolder: found ${allFound.length} new track(s) in "${folderPath}"`);

  tracks = tracks.concat(allFound);
  scheduleSave();
  return allFound;
}

async function rescanAll() {
  pruneMissingTracks();

  const results = [];
  for (const folderPath of watchedFolders) {
    if (!fs.existsSync(folderPath)) continue;
    const found = await scanFolder(folderPath);
    results.push({ folderPath, foundCount: found.length });
  }
  return results;
}

function pruneMissingTracks() {
  const missing = [];
  tracks = tracks.filter((t) => {
    const exists = fs.existsSync(t.filePath);
    if (!exists) missing.push(t.filePath);
    return exists;
  });

  if (missing.length) {
    const missingSet = new Set(missing);
    for (const p of playlists) {
      p.trackIds = p.trackIds.filter((fp) => !missingSet.has(fp));
    }
    console.log(`[Musik] pruneMissingTracks: removed ${missing.length} stale track(s) no longer on disk`);
    scheduleSave();
  }

  return missing;
}

function getRescanIntervalMinutes() {
  return rescanIntervalMinutes;
}

function setRescanIntervalMinutes(minutes) {
  const n = Number(minutes);
  rescanIntervalMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
  scheduleSave();
  return rescanIntervalMinutes;
}

function getWatchedFolders() {
  return watchedFolders.slice();
}

function removeWatchedFolder(folderPath) {
  const index = watchedFolders.indexOf(folderPath);
  if (index === -1) return false;
  watchedFolders.splice(index, 1);
  scheduleSave();
  return true;
}

function getTracks() {
  return tracks;
}

function getPlaylists() {
  return playlists;
}

function createPlaylist(name) {
  const playlist = {
    id: crypto.randomUUID(),
    name: (name && name.trim()) || 'New Playlist',
    folderPath: null,
    trackIds: [],
  };
  playlists.push(playlist);
  scheduleSave();
  return playlist;
}

function renamePlaylist(id, newName) {
  const playlist = playlists.find((p) => p.id === id);
  if (!playlist) return null;
  const trimmed = (newName || '').trim();
  if (trimmed) playlist.name = trimmed;
  scheduleSave();
  return playlist;
}

function deletePlaylist(id) {
  const index = playlists.findIndex((p) => p.id === id);
  if (index === -1) return false;

  const [removed] = playlists.splice(index, 1);

  if (removed.folderPath) {
    const idx = watchedFolders.indexOf(removed.folderPath);
    if (idx !== -1) watchedFolders.splice(idx, 1);
    recentlyDeletedFolderPaths.add(removed.folderPath);
  }

  // FIX: was scheduleSave() (500ms debounce). Delete, then quit/refresh
  // inside that window, and the write never happens — the playlist is
  // still sitting in the last-saved JSON and reappears on next load. This
  // was the actual bug being reported: delete looked correct in memory,
  // it just wasn't guaranteed to hit disk before the process could end.
  // Deletion is rare and deliberate, not a hot path like scanning, so
  // there's no real cost to flushing it immediately.
  flush();
  return true;
}

function addTrackToPlaylist(id, filePath) {
  const playlist = playlists.find((p) => p.id === id);
  if (!playlist) return null;
  if (!playlist.trackIds.includes(filePath)) {
    playlist.trackIds.push(filePath);
    scheduleSave();
  }
  return playlist;
}

function removeTrackFromPlaylist(id, filePath) {
  const playlist = playlists.find((p) => p.id === id);
  if (!playlist) return null;
  const index = playlist.trackIds.indexOf(filePath);
  if (index !== -1) {
    playlist.trackIds.splice(index, 1);
    scheduleSave();
  }
  return playlist;
}

function reorderPlaylistTracks(id, fromIndex, toIndex) {
  const playlist = playlists.find((p) => p.id === id);
  if (!playlist) return null;
  const ids = playlist.trackIds;
  if (
    fromIndex < 0 || fromIndex >= ids.length ||
    toIndex < 0 || toIndex >= ids.length
  ) {
    return playlist;
  }
  const [moved] = ids.splice(fromIndex, 1);
  ids.splice(toIndex, 0, moved);
  scheduleSave();
  return playlist;
}

module.exports = {
  init,
  flush,
  readTags,
  scanFolder,
  rescanAll,
  pruneMissingTracks,
  getRescanIntervalMinutes,
  setRescanIntervalMinutes,
  getTracks,
  getPlaylists,
  markPlayed,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
};