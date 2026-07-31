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
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {}
  return { enabled: {} };
}

function writeConfig(config) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (_) {}
}

function init(userDataPath) {
  modsDir = path.join(userDataPath, '..', 'musik-mods');
  const devModsDir = path.join(__dirname, '..', '..', 'mods');
  if (fs.existsSync(devModsDir)) modsDir = devModsDir;
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

function getModFile(modName, fileName) {
  if (!modsDir) return null;

  const safeModName = path.basename(modName);
  const safeFileName = path.basename(fileName);
  const filePath = path.join(modsDir, safeModName, safeFileName);

  if (!filePath.startsWith(modsDir)) return null;
  if (!fs.existsSync(filePath)) return null;

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
