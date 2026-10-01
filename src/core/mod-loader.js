// src/core/mod-loader.js
//
// Discovers mods on disk, parses manifests, serves file contents over IPC.
// Never executes mod JS here — that happens sandboxed in the renderer.

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

let modsDir = null;

function configPath() {
  return path.join(modsDir, 'mods-config.json');
}

function readConfig() {
  try {
    const p = configPath();
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed.enabled === 'object') return parsed;
    }
  } catch (_) {}
  return { enabled: {} };
}

function writeConfig(config) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (_) {}
}

function init(userDataPath, isPackaged = false) {
  modsDir = path.join(userDataPath, 'mods');
  const devModsDir = path.join(__dirname, '..', '..', 'mods');
  if (!isPackaged && fs.existsSync(devModsDir)) modsDir = devModsDir;
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  return modsDir;
}

function getModsDir() {
  return modsDir;
}

function openModsFolder() {
  if (!modsDir) return false;
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  shell.openPath(modsDir);
  return true;
}

function listMods() {
  if (!modsDir || !fs.existsSync(modsDir)) return [];

  const config = readConfig();
  const entries = fs.readdirSync(modsDir, { withFileTypes: true });
  const mods = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(modsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      mods.push({
        id: entry.name,
        name: manifest.name ?? entry.name,
        version: manifest.version ?? '0.0.0',
        author: manifest.author ?? 'Unknown',
        hasCss: fs.existsSync(path.join(modsDir, entry.name, 'theme.css')),
        hasJs: fs.existsSync(path.join(modsDir, entry.name, 'index.js')),
        enabled: config.enabled[entry.name] !== false, // default true
      });
    } catch (err) {
      console.warn(`[Musik] mod "${entry.name}" has invalid manifest.json:`, err.message);
    }
  }

  return mods;
}

function setModEnabled(modId, enabled) {
  if (!modsDir) return false;
  const config = readConfig();
  config.enabled[modId] = !!enabled;
  writeConfig(config);
  return true;
}

function getModFile(modName, relativePath) {
  if (!modsDir) return null;

  const safeModName = path.basename(modName);
  const modFolder = path.resolve(modsDir, safeModName);
  const filePath = path.resolve(modFolder, relativePath);

  // Strictly prevent escaping the mod's specific directory
  if (!filePath.startsWith(modFolder + path.sep)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;

  return fs.readFileSync(filePath, 'utf-8');
}

module.exports = {
  init,
  listMods,
  setModEnabled,
  getModFile,
  getModsDir,
  openModsFolder,
};
