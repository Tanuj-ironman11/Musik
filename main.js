const { app, BrowserWindow, ipcMain, dialog, shell, screen, nativeImage } = require('electron');
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
const ArtProvider = safeRequire('./src/core/art-provider');
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

// --- Taskbar thumbnail toolbar (Windows only — ITaskbarList3) ---
// This is the row of buttons Windows draws BELOW the hover-preview
// thumbnail (what Edge/Spotify/etc show) — distinct from the window's own
// content shrunk down, and distinct from the SMTC tray widget. Electron
// exposes it via win.setThumbarButtons(); it silently no-ops on non-Windows
// platforms but we still gate on process.platform.
//
// Button clicks route through the existing 'miniplayer-command' event
// player-ui.js already handles (togglePlayPause/previous/next) — reused
// deliberately rather than adding a parallel handler.
//
// nativeImage needs real bitmap data (no SVG support), so the four glyphs
// are embedded as base64 PNG data URLs rather than shipped as separate
// files.
let isPlayingForThumbar = false;

const THUMBAR_ICONS = {
  play: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAeUlEQVR4nO3WsQ3AMAhEURJlEPafypvEFRKdDRyiuV9HuSfSRIQxxgKp6o9+55tBICFhgIeMAgxRhZQAHjIKMEQGAgNkIXCAh4wCDHGCfJ2AtdZzeqbtAjfjIg0XuB2GA6LDFuQTZMdFiheoDFvpCyDGw3X8DzDGxttAjScf+nlinAAAAABJRU5ErkJggg==',
  pause: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAATUlEQVR4nO2VQQoAIAgErZf4/1f5k7qGeRAhKJq5uaw4N0UA4HdatqiqY53NbNvNdDy9cjzKMp2ywEkQQAABBBBA4A2B6K/7LNMBgCuZddcYIlCq23MAAAAASUVORK5CYII=',
  previous: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAfUlEQVR4nO2WMRLAIAgEMZOH8P9X8ROtbGMOzqG5rdXbwQE1E0KIA+4+3X1m957WPH8PQCQQ6U+BDGi13q7gDaUC2XCzYgUqwSUBRvAGvgJmOCzADocFImK0CtyQSLVhRAyWSGkOMEQog6giQXsLstWgP0b0Trn9HxBCtLMAlcIxvsphKh8AAAAASUVORK5CYII=',
  next: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAfUlEQVR4nO3Wuw2AMAxF0QdiEO8/lTeBylKEkPAvcvNuRUHio6QJwBhjjkTkzq77W3t2bvb+/+s7DfBslikMMEQXJAVYIaMAQ1QgZUAV0gZYIaOAKGILQFWPMUBkOABcU4PbANnBVukKqsOB5Al0DLbCJ9A53N3O9wBjbLwHunIt+AGt6ogAAAAASUVORK5CYII=',
};

function thumbarIcon(name) {
  const img = nativeImage.createFromDataURL(THUMBAR_ICONS[name]);
  if (img.isEmpty()) {
    console.warn(`[Musik] thumbar icon "${name}" decoded EMPTY — bad base64 or unsupported format`);
  }
  return img;
}

function updateThumbarButtons(win, isPlaying) {
  if (process.platform !== 'win32') {
    console.log('[Musik] skipping setThumbarButtons — not win32 (platform:', process.platform, ')');
    return;
  }
  if (!win || win.isDestroyed()) {
    console.warn('[Musik] skipping setThumbarButtons — window missing/destroyed');
    return;
  }
  try {
    const ok = win.setThumbarButtons([
      {
        tooltip: 'Previous',
        icon: thumbarIcon('previous'),
        click: () => emitToRenderer('miniplayer-command', { action: 'previous' }),
      },
      {
        tooltip: isPlaying ? 'Pause' : 'Play',
        icon: thumbarIcon(isPlaying ? 'pause' : 'play'),
        click: () => emitToRenderer('miniplayer-command', { action: 'togglePlayPause' }),
      },
      {
        tooltip: 'Next',
        icon: thumbarIcon('next'),
        click: () => emitToRenderer('miniplayer-command', { action: 'next' }),
      },
    ]);
    // setThumbarButtons returns false if it failed WITHOUT throwing — this
    // return value is easy to miss and was silently ignored before.
    console.log(`[Musik] setThumbarButtons(${isPlaying ? 'playing' : 'paused'}) returned:`, ok);
  } catch (err) {
    console.warn('[Musik] setThumbarButtons threw:', err.message);
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
    minHeight: 150,
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
    icon: path.join(__dirname, 'build', 'icon.ico'),
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
  updateThumbarButtons(mainWindow, isPlayingForThumbar);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (miniplayerWindow && !miniplayerWindow.isDestroyed()) miniplayerWindow.close();
  });

  mainWindow.on('enter-full-screen', () => emitToRenderer('fullscreenchange', { fullscreen: true }));
  mainWindow.on('leave-full-screen', () => emitToRenderer('fullscreenchange', { fullscreen: false }));

  // TEMP DEBUG — diagnosing the backdrop-filter flicker on #now-playing-bar.
  // F9 opens chrome://gpu in a plain window using THIS app's own bundled
  // Chromium/GPU process, not your regular browser, so we can see actual
  // "Problems Detected" for the process that's really rendering the bug.
  // Strip this whole block out once we're done diagnosing.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F9') {
      const gpuWin = new BrowserWindow({ width: 900, height: 700 });
      gpuWin.loadURL('chrome://gpu');
    }
  });
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
  if (name === 'play') {
    isPlayingForThumbar = true;
    updateThumbarButtons(mainWindow, true);
  } else if (name === 'pause') {
    isPlayingForThumbar = false;
    updateThumbarButtons(mainWindow, false);
  }
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
  const ok = ModLoader?.setModEnabled ? ModLoader.setModEnabled(modId, enabled) : false;
  // No live hot-injection/removal path for mod CSS/JS exists yet — reload
  // is the simplest correct fix (confirmed equivalent to the manual ctrl+r
  // workaround). Only reload on an actual successful toggle, not a no-op.
  if (ok && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  return ok;
});

ipcMain.handle('mods:open-folder', async () => {
  return ModLoader?.openModsFolder ? ModLoader.openModsFolder() : false;
});

ipcMain.handle('mods:get-dir', async () => {
  return ModLoader?.getModsDir ? ModLoader.getModsDir() : null;
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
// NEW CHANNEL — bulk-adds individual files straight to the library (not
// folder-aware, see Library.addFiles doc comment). Backs the "Add from
// Computer" option in the Add Tracks modal.
ipcMain.handle('library:add-files', async (_e, filePaths) => Library?.addFiles?.(filePaths) ?? []);

// --- Art ---
ipcMain.handle('art:extract', async (_e, filePath) => ArtProvider?.extract?.(filePath) ?? null);
ipcMain.handle('art:fetch-online', async (_e, trackMeta) => ArtProvider?.fetchOnline?.(trackMeta) ?? null);

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
ipcMain.handle('game-duck:set-track-loudness', async (_e, lufs) => GameDuck?.setTrackLoudness?.(lufs) ?? null);

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
