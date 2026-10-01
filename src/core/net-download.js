/* net-download.js — MAIN-PROCESS module (CommonJS). NEW IPC channel: 'net:download'.
 *
 * Wire-up (2 lines, you/the other AI apply them — I haven't seen main.js/preload.js):
 *   main.js:    require('./src/core/net-download').register(require('electron').ipcMain, app);
 *   preload.js: inside the existing Musik.net object add:
 *               download: (opts) => ipcRenderer.invoke('net:download', opts)
 *
 * Downloads an attachment to <temp>/musik-stream-cache/, names it from
 * Content-Disposition (falls back to magic-byte sniffing), returns
 * { ok, path, fileUrl, error }. Keeps the newest KEEP files, deletes the rest.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const KEEP = 5;
const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.zip']);

function sniffExt(buf) {
  const h = buf.subarray(0, 12).toString('latin1');
  if (h.startsWith('fLaC')) return '.flac';
  if (h.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return '.mp3';
  if (h.startsWith('OggS')) return '.ogg';
  if (h.startsWith('RIFF')) return '.wav';
  if (h.slice(4, 8) === 'ftyp') return '.m4a';
  if (h.startsWith('PK')) return '.zip';
  return '.bin';
}

function register(ipcMain, app) {
  const dir = path.join(app.getPath('temp'), 'musik-stream-cache');

  function prune() {
    try {
      fs.readdirSync(dir)
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(KEEP)
        .forEach(x => fs.unlink(path.join(dir, x.f), () => {}));
    } catch (_) { /* best effort */ }
  }

  ipcMain.handle('net:download', async (_e, opts) => {
    try {
      const { url, headers = {}, key = 'track' } = opts || {};
      if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'Bad download URL' };
      fs.mkdirSync(dir, { recursive: true });

      const res = await fetch(url, { headers }); // main-process fetch: no CORS
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' on download: ' + url };

      const safe = String(key).replace(/[^\w.-]+/g, '_').slice(0, 60);
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      let ext = m ? path.extname(decodeURIComponent(m[1])).toLowerCase() : '';
      const tmp = path.join(dir, safe + '.part');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));

      if (!AUDIO_EXT.has(ext)) {
        const fd = fs.openSync(tmp, 'r'); const b = Buffer.alloc(12);
        fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
        ext = sniffExt(b);
      }
      if (ext === '.zip' || ext === '.bin')
        { fs.unlink(tmp, () => {}); return { ok: false, error: 'Got a ' + ext + ' (multi-file/unknown) — not a single audio file.' }; }

      const out = path.join(dir, safe + ext);
      fs.renameSync(tmp, out);
      prune();
      return { ok: true, path: out, fileUrl: pathToFileURL(out).href };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = { register };
