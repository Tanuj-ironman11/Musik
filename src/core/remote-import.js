/* remote-import.js — main-process module. Downloads a remote file to disk and
 * returns its local path. Channels: 'import:fetch', 'net:download' (legacy name).
 * opts: { url, headers, key, kind: audio|image|text|any, saveDir, maxBytes, timeoutMs, blockPrivate }
 * result: { ok, path, fileUrl, ext, bytes, kind, error }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const { pathToFileURL } = require('url');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const KEEP = 5;
const CACHE_DIR_NAME = 'musik-remote-cache';

const EXT = {
  audio: new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']),
  text:  new Set(['.lrc', '.txt', '.json', '.cue', '.m3u', '.m3u8', '.srt']),
};
const REJECT = new Set(['.zip', '.bin']);

function sniffExt(buf) {
  const h = buf.subarray(0, 12).toString('latin1');
  if (h.startsWith('fLaC')) return '.flac';
  if (h.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return '.mp3';
  if (h.startsWith('OggS')) return '.ogg';
  if (h.startsWith('RIFF')) return h.slice(8, 12) === 'WEBP' ? '.webp' : '.wav';
  if (h.slice(4, 8) === 'ftyp') return '.m4a';
  if (buf[0] === 0x89 && h.slice(1, 4) === 'PNG') return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (h.startsWith('GIF8')) return '.gif';
  if (h.startsWith('PK')) return '.zip';
  return '.bin';
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
           (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') ||
         (v.startsWith('::ffff:') && isPrivateIp(v.slice(7)));
}

async function hostIsPrivate(hostname) {
  if (net.isIP(hostname)) return isPrivateIp(hostname);
  const addrs = await dns.lookup(hostname, { all: true });
  return addrs.some(a => isPrivateIp(a.address));
}

function register(ipcMain, app) {
  const cacheDir = path.join(app.getPath('temp'), CACHE_DIR_NAME);

  function prune() {
    try {
      fs.readdirSync(cacheDir)
        .map(f => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(KEEP)
        .forEach(x => fs.unlink(path.join(cacheDir, x.f), () => {}));
    } catch (_) {}
  }

  const handler = async (_e, opts) => {
    let tmp = '';
    let timer;
    try {
      const {
        url, headers = {}, key = 'track', kind = 'audio',
        saveDir, maxBytes = 0, timeoutMs = 0, blockPrivate = false,
      } = opts || {};

      if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'Bad URL' };
      if (!['audio', 'image', 'text', 'any'].includes(kind)) return { ok: false, error: 'Bad kind: ' + kind };
      if (saveDir && !path.isAbsolute(saveDir)) return { ok: false, error: 'saveDir must be an absolute path' };

      if (blockPrivate && await hostIsPrivate(new URL(url).hostname))
        return { ok: false, error: 'Blocked: host resolves to a private/local address' };

      const dir = saveDir || cacheDir;
      fs.mkdirSync(dir, { recursive: true });

      const ctl = new AbortController();
      if (timeoutMs > 0) timer = setTimeout(() => ctl.abort(), timeoutMs);

      const res = await fetch(url, { headers, signal: ctl.signal });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' fetching: ' + url };
      if (maxBytes > 0 && Number(res.headers.get('content-length')) > maxBytes)
        return { ok: false, error: 'File larger than allowed size' };

      const safe = String(key).replace(/[^\w.-]+/g, '_').slice(0, 60);
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      let ext = m ? path.extname(decodeURIComponent(m[1])).toLowerCase() : '';
      tmp = path.join(dir, safe + '.part');

      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          if (maxBytes > 0 && bytes > maxBytes) return cb(new Error('File larger than allowed size'));
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
      clearTimeout(timer);

      const allowed = kind === 'any' ? null : EXT[kind];
      const known = ext && (REJECT.has(ext) || Object.values(EXT).some(s => s.has(ext)));
      if (!known) {
        const fd = fs.openSync(tmp, 'r'); const b = Buffer.alloc(12);
        fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
        const sniffed = sniffExt(b);
        ext = (kind === 'text' && sniffed === '.bin')
          ? (path.extname(new URL(url).pathname).toLowerCase() || '.txt')
          : sniffed;
      }

      if (REJECT.has(ext)) {
        fs.unlink(tmp, () => {});
        return { ok: false, error: 'Got a ' + ext + ' (archive/unknown) — expected a single ' + kind + ' file.' };
      }
      if (allowed && !allowed.has(ext)) {
        fs.unlink(tmp, () => {});
        return { ok: false, error: 'Got ' + ext + ', expected ' + kind + '.' };
      }

      const out = path.join(dir, safe + ext);
      fs.renameSync(tmp, out);
      if (!saveDir) prune();
      return { ok: true, path: out, fileUrl: pathToFileURL(out).href, ext, bytes, kind };
    } catch (e) {
      if (tmp) fs.unlink(tmp, () => {});
      return { ok: false, error: e.name === 'AbortError' ? 'Timed out' : (e.message || String(e)) };
    } finally {
      clearTimeout(timer);
    }
  };

  ipcMain.handle('import:fetch', handler);
  ipcMain.handle('net:download', handler); // legacy name, kept for compatibility
}

module.exports = { register };
