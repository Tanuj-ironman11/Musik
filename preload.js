const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Internal event bus — shared by window.Musik.events and the legacy
// window.Aurelius.events shim so both surfaces stay in sync.
// Events: trackupdate, play, pause, seek, artupdate, viewchange, queueupdate, duckupdate, duckdebug, fullscreenchange, libraryupdate
// ---------------------------------------------------------------------------
const listeners = new Map(); // eventName -> Set<callback>

function on(eventName, callback) {
  if (!listeners.has(eventName)) listeners.set(eventName, new Set());
  listeners.get(eventName).add(callback);
  return () => off(eventName, callback);
}

function off(eventName, callback) {
  if (listeners.has(eventName)) listeners.get(eventName).delete(callback);
}

function emit(eventName, payload) {
  if (listeners.has(eventName)) {
    for (const cb of listeners.get(eventName)) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[Musik] listener error for "${eventName}":`, err);
      }
    }
  }
}

// Main process pushes events over this single IPC channel; renderer fans out.
ipcRenderer.on('musik:event', (_event, { name, payload }) => emit(name, payload));

// ---------------------------------------------------------------------------
// window.Musik — primary mod-facing API
// ---------------------------------------------------------------------------
const Musik = {
  player: {
    play: (trackId) => ipcRenderer.invoke('player:play', trackId),
    pause: () => ipcRenderer.invoke('player:pause'),
    seek: (seconds) => ipcRenderer.invoke('player:seek', seconds),
    setVolume: (value) => ipcRenderer.invoke('player:set-volume', value),
    getState: () => ipcRenderer.invoke('player:get-state'),
    getCurrentTrack: () => ipcRenderer.invoke('player:get-current-track'),
  },

  queue: {
    // Mirrors QueueManager methods 1:1 — additive surface, see AURELIUS_BRIEF.
    getQueue: () => ipcRenderer.invoke('queue:get'),
    add: (track) => ipcRenderer.invoke('queue:add', track),
    remove: (index) => ipcRenderer.invoke('queue:remove', index),
    clear: () => ipcRenderer.invoke('queue:clear'),
    next: () => ipcRenderer.invoke('queue:next'),
    previous: () => ipcRenderer.invoke('queue:previous'),
    jumpTo: (index) => ipcRenderer.invoke('queue:jump-to', index),
    move: (fromIndex, toIndex) => ipcRenderer.invoke('queue:move', fromIndex, toIndex),
    shuffle: (enabled) => ipcRenderer.invoke('queue:shuffle', enabled),
    setRepeatMode: (mode) => ipcRenderer.invoke('queue:set-repeat-mode', mode),
  },

  library: {
    getTracks: () => ipcRenderer.invoke('library:get-tracks'),
    getPlaylists: () => ipcRenderer.invoke('library:get-playlists'),
    scanFolder: (folderPath) => ipcRenderer.invoke('library:scan-folder', folderPath),
    readTags: (filePath) => ipcRenderer.invoke('read-tags', filePath),
    createPlaylist: (name) => ipcRenderer.invoke('library:create-playlist', name),
    renamePlaylist: (id, newName) => ipcRenderer.invoke('library:rename-playlist', id, newName),
    deletePlaylist: (id) => ipcRenderer.invoke('library:delete-playlist', id),
    addTrack: (id, filePath) => ipcRenderer.invoke('library:add-track', id, filePath),
    removeTrack: (id, filePath) => ipcRenderer.invoke('library:remove-track', id, filePath),
    reorderTracks: (id, fromIndex, toIndex) => ipcRenderer.invoke('library:reorder-tracks', id, fromIndex, toIndex),
    rescanAll: () => ipcRenderer.invoke('library:rescan-all'),
    getRescanSettings: () => ipcRenderer.invoke('library:get-rescan-settings'),
    setRescanInterval: (minutes) => ipcRenderer.invoke('library:set-rescan-interval', minutes),
  },

  lyrics: {
    get: (trackMeta) => ipcRenderer.invoke('lyrics:get', trackMeta),
    saveManual: (trackMeta, payload) => ipcRenderer.invoke('lyrics:save-manual', trackMeta, payload),
    clearManual: (trackMeta) => ipcRenderer.invoke('lyrics:clear-manual', trackMeta),
    romanizeLines: (lines) => ipcRenderer.invoke('lyrics:romanize-lines', lines),
  },

  art: {
    extract: (filePath) => ipcRenderer.invoke('art:extract', filePath),
    fetchOnline: (trackMeta) => ipcRenderer.invoke('art:fetch-online', trackMeta),
  },

  scrobble: {
    getSettings: () => ipcRenderer.invoke('scrobble:get-settings'),
    setCredentials: (creds) => ipcRenderer.invoke('scrobble:set-credentials', creds),
    getAuthUrl: () => ipcRenderer.invoke('scrobble:get-auth-url'),
    completeAuth: (token) => ipcRenderer.invoke('scrobble:complete-auth', token),
    disconnect: () => ipcRenderer.invoke('scrobble:disconnect'),
    // Internal — player-ui.js calls these directly off track events.
    // Exposed on window.Musik too since mods may want to observe/override
    // scrobble timing (e.g. a "never scrobble podcasts" mod).
    nowPlaying: (track) => ipcRenderer.invoke('scrobble:now-playing', track),
    submitScrobble: (track, timestamp) => ipcRenderer.invoke('scrobble:scrobble', track, timestamp),
    getLifetimeStats: () => ipcRenderer.invoke('scrobble:get-lifetime-stats'),
  },

  stats: {
    getSession: () => ipcRenderer.invoke('stats:get-session'),
    getLifetime: () => ipcRenderer.invoke('stats:get-lifetime'),
    // Internal — player-ui.js calls this directly off the same trigger as
    // scrobble.submitScrobble. Exposed on window.Musik too since mods may
    // want to observe play counts (e.g. an alternate stats display mod).
    recordPlay: (track) => ipcRenderer.invoke('stats:record-play', track),
  },

  gameDuck: {
    getSettings: () => ipcRenderer.invoke('game-duck:get-settings'),
    setEnabled: (value) => ipcRenderer.invoke('game-duck:set-enabled', value),
    setSensitivity: (value) => ipcRenderer.invoke('game-duck:set-sensitivity', value),
    setDuckCeiling: (value) => ipcRenderer.invoke('game-duck:set-duck-ceiling', value),
    setMaxDuck: (value) => ipcRenderer.invoke('game-duck:set-max-duck', value),
    setManualOverride: (value) => ipcRenderer.invoke('game-duck:set-manual-override', value),
    setTrackLoudness: (lufs) => ipcRenderer.invoke('game-duck:set-track-loudness', lufs),
  },

  mods: {
    list: () => ipcRenderer.invoke('load-mods'),
    getFile: (modName, fileName) => ipcRenderer.invoke('get-mod-file', modName, fileName),
    setEnabled: (modId, enabled) => ipcRenderer.invoke('set-mod-enabled', modId, enabled),
    openFolder: () => ipcRenderer.invoke('mods:open-folder'),
    getDir: () => ipcRenderer.invoke('mods:get-dir'),
  },

  ui: {
    injectCSS: (css) => ipcRenderer.invoke('ui:inject-css', css),
    injectElement: (html, targetSelector) =>
      ipcRenderer.invoke('ui:inject-element', html, targetSelector),
    removeElement: (elementId) => ipcRenderer.invoke('ui:remove-element', elementId),
    getView: () => ipcRenderer.invoke('ui:get-view'),
    onViewChange: (callback) => on('viewchange', callback),
  },

  theme: {
    setVar: (name, value) => ipcRenderer.invoke('theme:set-var', name, value),
    getAccent: () => ipcRenderer.invoke('theme:get-accent'),
  },

  dialog: {
    openFile: () => ipcRenderer.invoke('open-file-dialog'),
  },

  system: {
    openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    platform: () => ipcRenderer.invoke('window:platform'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    toggleMiniplayer: () => ipcRenderer.invoke('window:toggle-miniplayer'),
    isMiniplayerOpen: () => ipcRenderer.invoke('window:is-miniplayer-open'),
  },

  // Miniplayer-specific surface. `command()` is what the miniplayer's own
  // renderer uses to drive playback in the main window (see main.js relay
  // comment); `getSettings`/`setAlwaysOnTop` back the floats-on-top toggle,
  // which per the brief is a setting, not a forced behavior.
  miniplayer: {
    getSettings: () => ipcRenderer.invoke('miniplayer:get-settings'),
    setAlwaysOnTop: (value) => ipcRenderer.invoke('miniplayer:set-always-on-top', value),
    command: (action, args) => ipcRenderer.invoke('miniplayer:command', action, args),
    // Grows/shrinks the miniplayer window for the inline queue popup.
    // Separate from the drag-resize path so it never gets persisted as
    // the user's manually-set size.
    resizeForQueue: (open) => ipcRenderer.invoke('miniplayer:resize-for-queue', open),
  },

  events: {
    on,
    off,
    emit,
    // Distinct from local emit() above (which only fires listeners inside
    // THIS renderer). push() sends the event to main.js, which re-emits it
    // to every window via the normal musik:event broadcast — needed for
    // request-state-sync, where the main window has to hand its current
    // state to a miniplayer that just opened, not just fire local callbacks.
    push: (name, payload) => ipcRenderer.invoke('musik:push-event', name, payload),
  },
};

// ---------------------------------------------------------------------------
// window.Aurelius — legacy shim for backward compatibility with older mods.
// Only wraps what old mods actually used; new mods should target window.Musik.
// Never remove or rename keys here without flagging it first.
// ---------------------------------------------------------------------------
const Aurelius = {
  player: Musik.player,
  library: {
    getTracks: Musik.library.getTracks,
    getPlaylists: Musik.library.getPlaylists,
  },
  ui: Musik.ui,
  events: { on, off, emit },
  theme: Musik.theme,
};

contextBridge.exposeInMainWorld('Musik', Musik);
contextBridge.exposeInMainWorld('Aurelius', Aurelius);
