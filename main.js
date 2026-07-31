const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('path');
const fs = require('fs');

function safeRequire(relPath) {
  try {
    return require(relPath);
  } catch (err) {
    console.warn(`[Musik] optional core module not loaded: ${relPath} (${err.message})`);
    return null;
  }
}

const AudioEngine = safeRequire('./src/core/audio-engine');
const Library = safeRequire('./src/core/library');
const ArtExtractor = safeRequire('./src/core/art-extractor');
const ArtFetcher = safeRequire('./src/core/art-fetcher');
const ModLoader = safeRequire('./src/core/mod-loader');
const QueueManager = safeRequire('./src/core/queue-manager');
const Lyrics = safeRequire('./src/core/lyrics');
const Scrobbler = safeRequire('./src/core/scrobbler');
const GameDuck = safeRequire('./src/core/game-duck');
const Stats = safeRequire('./src/core/stats');

let mainWindow = null;
let miniplayerWindow = null;
let resizingForQueue = false;
let preQueueBounds = null;
const QUEUE_PANEL_HEIGHT = 240;

function emitToRenderer(name, payload) {
  for (const win of [mainWindow, miniplayerWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('musik:event', { name, payload });
    }
  }
}

const miniplayerStorePath = () => path.join(app.getPath('userData'), 'miniplayer.json');
function readMiniplayerSettings() {
  try {
    const p = miniplayerStorePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {}
  return { alwaysOnTop: false, width: 320, height: 180 };
}
function writeMiniplayerSettings(settings) {
  try {
    fs.writeFileSync(miniplayerStorePath(), JSON.stringify(settings, null, 2));
  } catch (_) {}
}

function createMiniplayerWindow() {
  const settings = readMiniplayerSettings();
  miniplayerWindow = new BrowserWindow({
    width: settings.width || 320,
    height: settings.height || 180,
    minWidth: 220,
    minHeight: 120,
    // transparent:true + no backgroundColor — combining the two on Windows
    // paints an opaque square instead of real per-pixel transparency.
    transparent: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    thickFrame: false,
    hasShadow: false,
    alwaysOnTop: !!settings.alwaysOnTop,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  miniplayerWindow.loadFile('miniplayer.html');

  miniplayerWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('musik:event', { name: 'request-state-sync', payload: {} });
    }
  });

  miniplayerWindow.on('resized', () => {
    if (!miniplayerWindow || miniplayerWindow.isDestroyed()) return;
    if (resizingForQueue) return;
    const [width, height] = miniplayerWindow.getSize();
    writeMiniplayerSettings({ ...readMiniplayerSettings(), width, height });
  });

  miniplayerWindow.on('closed', () => {
    miniplayerWindow = null;
    emitToRenderer('miniplayerchange', { open: false });
  });

  return miniplayerWindow;
}

function resizeMiniplayerForQueue(open) {
  if (!miniplayerWindow || miniplayerWindow.isDestroyed()) return;
  resizingForQueue = true;

  if (open) {
    preQueueBounds = miniplayerWindow.getBounds();
    const display = screen.getDisplayMatching(preQueueBounds);
    const spaceBelow = (display.workArea.y + display.workArea.height) - (preQueueBounds.y + preQueueBounds.height);
    const growDown = spaceBelow >= QUEUE_PANEL_HEIGHT;

    const newHeight = preQueueBounds.height + QUEUE_PANEL_HEIGHT;
    const newY = growDown ? preQueueBounds.y : Math.max(display.workArea.y, preQueueBounds.y - QUEUE_PANEL_HEIGHT);

    miniplayerWindow.setBounds({ ...preQueueBounds, y: newY, height: newHeight });
  } else if (preQueueBounds) {
    miniplayerWindow.setBounds(preQueueBounds);
    preQueueBounds = null;
  }

  setImmediate(() => { resizingForQueue = false; });
}

function toggleMiniplayer() {
  if (miniplayerWindow && !miniplayerWindow.isDestroyed()) {
    miniplayerWindow.close();
    return false;
  }
  createMiniplayerWindow();
  emitToRenderer('miniplayerchange', { open: true });
  return true;
}

// Plain-text tail log for the game-duck meter when fullscreen-exclusive
// games block overlay windows. Capped ~1MB, trimmed to last ~200KB.
const duckDebugLogPath = () => path.join(app.getPath('userData'), 'duck-debug.log');
let duckDebugLogSizeChecked = 0;
function appendDuckDebugLog(level, target, smoothed) {
  const logPath = duckDebugLogPath();
  const line = `${new Date().toISOString()} level=${level.toFixed(2)} target=${target.toFixed(2)} vol=${smoothed.toFixed(2)}\n`;
  try {
    fs.appendFileSync(logPath, line);
    duckDebugLogSizeChecked++;
    if (duckDebugLogSizeChecked >= 200) {
      duckDebugLogSizeChecked = 0;
      const { size } = fs.statSync(logPath);
      if (size > 1024 * 1024) {
        const buf = fs.readFileSync(logPath);
        fs.writeFileSync(logPath, buf.subarray(buf.length - 200 * 1024));
      }
    }
  } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // transparent must stay false here — setBackgroundMaterial (acrylic/mica)
    // silently no-ops when transparent:true is also set.
    backgroundColor: '#00000000',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (miniplayerWindow && !miniplayerWindow.isDestroyed()) miniplayerWindow.close();
  });

  mainWindow.on('enter-full-screen', () => emitToRenderer('fullscreenchange', { fullscreen: true }));
  mainWindow.on('leave-full-screen', () => emitToRenderer('fullscreenchange', { fullscreen: false }));
}

let rescanTimer = null;

function emitLibraryUpdate(result) {
  emitToRenderer('libraryupdate', result ?? {});
}

async function runRescanAll() {
  try {
    const results = await Library?.rescanAll?.();
    emitLibraryUpdate({ results });
  } catch (err) {
    console.warn('[Musik] auto-rescan failed:', err.message);
  }
}

function restartRescanTimer() {
  if (rescanTimer) {
    clearInterval(rescanTimer);
    rescanTimer = null;
  }
  const minutes = Library?.getRescanIntervalMinutes?.() ?? 0;
  if (minutes > 0) {
    rescanTimer = setInterval(runRescanAll, minutes * 60 * 1000);
  }
}

function boot() {
  createWindow();
  ModLoader?.init?.(app.getPath('userData'));
  Library?.init?.(app.getPath('userData'));
  setTimeout(runRescanAll, 3000);
  restartRescanTimer();
  GameDuck?.init?.(
    app.getPath('userData'),
    (multiplier) => emitToRenderer('duckupdate', { multiplier }),
    (level, target, smoothed) => {
      emitToRenderer('duckdebug', { level, target, smoothed });
      appendDuckDebugLog(level, target, smoothed);
    }
  );
  Scrobbler?.init?.(app.getPath('userData'));
  Lyrics?.init?.(app.getPath('userData'));
  Stats?.init?.(app.getPath('userData'));
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('musik:push-event', (_e, name, payload) => {
  emitToRenderer(name, payload);
  return true;
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'aiff', 'ogg', 'opus', 'aac', 'm4a', 'alac'] },
    ],
  });
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle('load-mods', async () => {
  return ModLoader?.listMods ? ModLoader.listMods() : [];
});

ipcMain.handle('get-mod-file', async (_e, modName, fileName) => {
  return ModLoader?.getModFile ? ModLoader.getModFile(modName, fileName) : null;
});

ipcMain.handle('set-mod-enabled', async (_e, modId, enabled) => {
  return ModLoader?.setModEnabled ? ModLoader.setModEnabled(modId, enabled) : false;
});

ipcMain.handle('mods:open-folder', async () => {
  return ModLoader?.openModsFolder ? ModLoader.openModsFolder() : false;
});

ipcMain.handle('read-tags', async (_e, filePath) => {
  return Library?.readTags ? Library.readTags(filePath) : null;
});

// --- Window controls ---
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:platform', () => process.platform);
ipcMain.handle('window:toggle-fullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});
ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false);

// --- Miniplayer ---
ipcMain.handle('window:toggle-miniplayer', () => toggleMiniplayer());
ipcMain.handle('window:is-miniplayer-open', () => !!(miniplayerWindow && !miniplayerWindow.isDestroyed()));

ipcMain.handle('miniplayer:get-settings', () => readMiniplayerSettings());
ipcMain.handle('miniplayer:set-always-on-top', (_e, value) => {
  const settings = { ...readMiniplayerSettings(), alwaysOnTop: !!value };
  writeMiniplayerSettings(settings);
  if (miniplayerWindow && !miniplayerWindow.isDestroyed()) {
    miniplayerWindow.setAlwaysOnTop(!!value);
  }
  return settings;
});

ipcMain.handle('miniplayer:command', (_e, action, args) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('musik:event', { name: 'miniplayer-command', payload: { action, args } });
  }
  return true;
});

ipcMain.handle('miniplayer:resize-for-queue', (_e, open) => {
  resizeMiniplayerForQueue(!!open);
  return true;
});

// --- Player ---
ipcMain.handle('player:play', async (_e, trackId) => AudioEngine?.play?.(trackId));
ipcMain.handle('player:pause', async () => AudioEngine?.pause?.());
ipcMain.handle('player:seek', async (_e, seconds) => AudioEngine?.seek?.(seconds));
ipcMain.handle('player:set-volume', async (_e, value) => AudioEngine?.setVolume?.(value));
ipcMain.handle('player:get-state', async () => AudioEngine?.getState?.() ?? null);
ipcMain.handle('player:get-current-track', async () => AudioEngine?.getCurrentTrack?.() ?? null);

// --- Queue ---
ipcMain.handle('queue:get', async () => QueueManager?.getQueue?.() ?? []);
ipcMain.handle('queue:add', async (_e, track) => QueueManager?.add?.(track));
ipcMain.handle('queue:remove', async (_e, index) => QueueManager?.remove?.(index));
ipcMain.handle('queue:clear', async () => QueueManager?.clear?.());
ipcMain.handle('queue:next', async () => QueueManager?.next?.());
ipcMain.handle('queue:previous', async () => QueueManager?.previous?.());
ipcMain.handle('queue:jump-to', async (_e, index) => QueueManager?.jumpTo?.(index));
ipcMain.handle('queue:move', async (_e, fromIndex, toIndex) => QueueManager?.move?.(fromIndex, toIndex));
ipcMain.handle('queue:shuffle', async (_e, enabled) => QueueManager?.shuffle?.(enabled));
ipcMain.handle('queue:set-repeat-mode', async (_e, mode) => QueueManager?.setRepeatMode?.(mode));

// --- Library ---
ipcMain.handle('library:get-tracks', async () => Library?.getTracks?.() ?? []);
ipcMain.handle('library:get-playlists', async () => Library?.getPlaylists?.() ?? []);
ipcMain.handle('library:scan-folder', async (_e, folderPath) => Library?.scanFolder?.(folderPath));
ipcMain.handle('library:rescan-all', async () => {
  const results = await Library?.rescanAll?.();
  emitLibraryUpdate({ results });
  return results;
});
ipcMain.handle('library:get-rescan-settings', () => ({
  intervalMinutes: Library?.getRescanIntervalMinutes?.() ?? 0,
}));
ipcMain.handle('library:set-rescan-interval', (_e, minutes) => {
  const applied = Library?.setRescanIntervalMinutes?.(minutes) ?? 0;
  restartRescanTimer();
  return applied;
});
ipcMain.handle('library:mark-played', async (_e, filePath) => Library?.markPlayed?.(filePath) ?? null);

ipcMain.handle('library:create-playlist', async (_e, name) => Library?.createPlaylist?.(name) ?? null);
ipcMain.handle('library:rename-playlist', async (_e, id, newName) => Library?.renamePlaylist?.(id, newName) ?? null);
ipcMain.handle('library:delete-playlist', async (_e, id) => Library?.deletePlaylist?.(id) ?? false);
ipcMain.handle('library:add-track', async (_e, id, filePath) => Library?.addTrackToPlaylist?.(id, filePath) ?? null);
ipcMain.handle('library:remove-track', async (_e, id, filePath) => Library?.removeTrackFromPlaylist?.(id, filePath) ?? null);
ipcMain.handle('library:reorder-tracks', async (_e, id, fromIndex, toIndex) => Library?.reorderPlaylistTracks?.(id, fromIndex, toIndex) ?? null);

// --- Art ---
ipcMain.handle('art:extract', async (_e, filePath) => ArtExtractor?.extract?.(filePath) ?? null);
ipcMain.handle('art:fetch-online', async (_e, trackMeta) => ArtFetcher?.fetch?.(trackMeta) ?? null);

// --- Lyrics ---
ipcMain.handle('lyrics:get', async (_e, trackMeta) => Lyrics?.get?.(trackMeta) ?? null);
ipcMain.handle('lyrics:save-manual', async (_e, trackMeta, payload) => Lyrics?.saveManual?.(trackMeta, payload) ?? null);
ipcMain.handle('lyrics:clear-manual', async (_e, trackMeta) => Lyrics?.clearManual?.(trackMeta) ?? null);
ipcMain.handle('lyrics:romanize-lines', async (_e, lines) => Lyrics?.romanizeLines?.(lines) ?? null);

// --- Scrobbling ---
ipcMain.handle('scrobble:get-settings', async () => Scrobbler?.getSettings?.() ?? null);
ipcMain.handle('scrobble:set-credentials', async (_e, creds) => Scrobbler?.setCredentials?.(creds));
ipcMain.handle('scrobble:get-auth-url', async () => Scrobbler?.getAuthUrl?.() ?? null);
ipcMain.handle('scrobble:complete-auth', async (_e, token) => {
  if (!Scrobbler?.completeAuth) return null;
  try {
    const result = await Scrobbler.completeAuth(token);
    Stats?.markLastfmConnected?.();
    return result;
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('scrobble:disconnect', async () => Scrobbler?.disconnect?.() ?? false);
ipcMain.handle('scrobble:now-playing', async (_e, track) => Scrobbler?.updateNowPlaying?.(track) ?? null);
ipcMain.handle('scrobble:scrobble', async (_e, track, timestamp) => Scrobbler?.scrobble?.(track, timestamp) ?? null);
ipcMain.handle('scrobble:get-lifetime-stats', async () => Scrobbler?.getLifetimeLastfmStats?.() ?? null);

// --- Game-reactive volume ducking (Windows only) ---
ipcMain.handle('game-duck:get-settings', async () => GameDuck?.getSettings?.() ?? { available: false });
ipcMain.handle('game-duck:set-enabled', async (_e, value) => GameDuck?.setEnabled?.(value) ?? null);
ipcMain.handle('game-duck:set-sensitivity', async (_e, value) => GameDuck?.setSensitivity?.(value) ?? null);
ipcMain.handle('game-duck:set-duck-ceiling', async (_e, value) => GameDuck?.setDuckCeiling?.(value) ?? null);
ipcMain.handle('game-duck:set-max-duck', async (_e, value) => GameDuck?.setMaxDuck?.(value) ?? null);
ipcMain.handle('game-duck:set-manual-override', async (_e, value) => GameDuck?.setManualOverride?.(value) ?? null);

// --- Stats ---
ipcMain.handle('stats:get-session', async () => Stats?.getSessionStats?.() ?? null);
ipcMain.handle('stats:get-lifetime', async () => Stats?.getLifetimeStats?.() ?? null);
ipcMain.handle('stats:record-play', async (_e, track) => Stats?.recordPlay?.(track) ?? null);

// --- Theme ---
const themeStorePath = () => path.join(app.getPath('userData'), 'theme.json');

ipcMain.handle('theme:set-var', async (_e, name, value) => {
  const storePath = themeStorePath();
  const store = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf-8')) : {};
  store[name] = value;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  emitToRenderer('artupdate', { name, value });
  return true;
});

ipcMain.handle('theme:get-accent', async () => {
  const storePath = themeStorePath();
  if (!fs.existsSync(storePath)) return null;
  const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  return store['--accent'] ?? null;
});

// --- UI (mod-driven injection; DOM work happens in renderer) ---
ipcMain.handle('ui:inject-css', async (_e, css) => {
  emitToRenderer('inject-css', css);
  return true;
});
ipcMain.handle('ui:inject-element', async (_e, html, targetSelector) => {
  emitToRenderer('inject-element', { html, targetSelector });
  return true;
});
ipcMain.handle('ui:remove-element', async (_e, elementId) => {
  emitToRenderer('remove-element', elementId);
  return true;
});
ipcMain.handle('ui:get-view', async () => AudioEngine ? null : null);

// --- System ---
ipcMain.handle('system:open-external', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});
