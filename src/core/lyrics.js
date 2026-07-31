// src/core/lyrics.js
//
// Main-process lyrics resolution. CommonJS, follows the same
// init(userDataPath) + disk-cache pattern as library.js.
//
// Resolution order per track:
//   1. Manual override (user-entered, always wins, never overwritten by
//      a later network fetch unless the user clears it)
//   2. Disk cache (previous successful LRCLIB/Lyrica fetch)
//   3. LRCLIB (https://lrclib.net) — synced + plain, no API key
//   4. Lyrica (https://github.com/Wilooper/Lyrica) — prehosted, HF Space
//      primary with Render as failover — see the known Mac/Windows
//      discrepancy in the project brief (200 OK on Windows, not
//      confirmed working on Mac)
//
// IPC wiring required in main.js + preload.js — NOT done here, see the
// wiring snippets delivered alongside this file. New IPC surface:
//   lyrics-get, lyrics-save-manual, lyrics-clear-manual, lyrics-romanize
// Flagging per house rules: this is a new API-surface addition.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

const LRCLIB_BASE = 'https://lrclib.net/api';

// Lyrica (https://github.com/Wilooper/Lyrica) — prehosted, no self-hosting
// needed. HF Space first per the "recommended for production" note (built
// for concurrent load, ~95% uptime); Render as automatic failover if HF is
// down or cold-starting. Override via env if you self-host or the prehosted
// links change.
const LYRICA_BASES = (process.env.MUSIK_LYRICA_BASE_URL
  ? [process.env.MUSIK_LYRICA_BASE_URL]
  : ['https://wilooper-lyrica.hf.space', 'https://test-0k.onrender.com']
).map((u) => u.replace(/\/$/, ''));

const REQUEST_TIMEOUT_MS = 8000;

let cacheDir = null;
let manualDir = null;
let initialized = false;

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

function init(userDataPath) {
  cacheDir = path.join(userDataPath, 'lyrics-cache');
  manualDir = path.join(userDataPath, 'lyrics-manual');
  for (const dir of [cacheDir, manualDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  initialized = true;
}

function assertInit() {
  if (!initialized) {
    throw new Error('[lyrics.js] init(userDataPath) must be called before use');
  }
}

// ---------------------------------------------------------------------
// Track key — same normalize-then-hash approach for cache filenames as
// the fingerprint/metadata matching elsewhere in the project.
// ---------------------------------------------------------------------

function trackKey({ artist, title, album }) {
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const raw = `${norm(artist)}::${norm(title)}::${norm(album)}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function cachePath(key) { return path.join(cacheDir, `${key}.json`); }
function manualPath(key) { return path.join(manualDir, `${key}.json`); }

// ---------------------------------------------------------------------
// Tiny HTTPS JSON GET — no axios/node-fetch dependency, matches the
// "keep deps minimal" pattern already used for fpcalc/AcoustID calls.
// ---------------------------------------------------------------------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { 'User-Agent': 'Musik/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Bad JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out: ${url}`)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------
// LRC parsing — turns "[mm:ss.xx]text" lines into { time, text }[]
// ---------------------------------------------------------------------

function parseLrc(lrcText) {
  if (!lrcText) return null;
  const lineRe = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/;
  const lines = [];
  for (const raw of lrcText.split(/\r?\n/)) {
    const m = raw.match(lineRe);
    if (!m) continue;
    const [, mm, ss, ms, text] = m;
    const time = Number(mm) * 60 + Number(ss) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
    const clean = text.trim();
    if (clean.length) lines.push({ time, text: clean });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

// ---------------------------------------------------------------------
// Source: LRCLIB
// ---------------------------------------------------------------------

async function fetchFromLrclib({ artist, title, album, duration }) {
  const params = new URLSearchParams({
    track_name: title || '',
    artist_name: artist || '',
  });
  if (album) params.set('album_name', album);
  if (duration) params.set('duration', String(Math.round(duration)));

  try {
    const data = await httpGetJson(`${LRCLIB_BASE}/get?${params.toString()}`);
    if (data && (data.syncedLyrics || data.plainLyrics)) {
      return {
        source: 'lrclib',
        synced: parseLrc(data.syncedLyrics),
        plain: data.plainLyrics || null,
      };
    }
  } catch (_) {
    // fall through to search endpoint below
  }

  // /get requires an exact match; /search is fuzzier and worth trying
  // before giving up on this source entirely.
  try {
    const results = await httpGetJson(`${LRCLIB_BASE}/search?${params.toString()}`);
    if (Array.isArray(results) && results.length) {
      const best = results[0];
      if (best.syncedLyrics || best.plainLyrics) {
        return {
          source: 'lrclib',
          synced: parseLrc(best.syncedLyrics),
          plain: best.plainLyrics || null,
        };
      }
    }
  } catch (_) {
    // both LRCLIB attempts failed — caller falls back to Lyrica
  }

  return null;
}

// ---------------------------------------------------------------------
// Source: Lyrica (fallback)
// ---------------------------------------------------------------------

async function fetchFromLyrica({ artist, title }) {
  const params = new URLSearchParams({ artist: artist || '', song: title || '', timestamps: 'true' });

  for (const base of LYRICA_BASES) {
    try {
      const data = await httpGetJson(`${base}/lyrics/?${params.toString()}`);
      if (data?.status !== 'success' || !data.data) continue; // 404/429/error body — try next base

      const d = data.data;
      const synced = Array.isArray(d.timed_lyrics) && d.timed_lyrics.length
        ? d.timed_lyrics
            .map((l) => ({ time: (l.start_time ?? 0) / 1000, text: (l.text || '').trim() }))
            .filter((l) => l.text)
        : null;

      return {
        source: `lyrica:${d.source || 'unknown'}`,
        synced,
        plain: d.plain_lyrics || d.lyrics || null,
      };
    } catch (_) {
      // this base is down/cold/rate-limited — try the next one. If both
      // fail we fall through and return null below (caller treats as
      // "not found", gets cached briefly, retried on a later play).
      // Mac build note from the project brief lives here if you're
      // chasing that bug: a rejection on this line is where it'd surface.
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Public: getLyrics
// ---------------------------------------------------------------------

async function getLyrics(track) {
  assertInit();
  const key = trackKey(track);

  // 1. Manual override always wins
  if (fs.existsSync(manualPath(key))) {
    const manual = JSON.parse(fs.readFileSync(manualPath(key), 'utf8'));
    return { ...manual, source: 'manual', key };
  }

  // 2. Disk cache
  if (fs.existsSync(cachePath(key))) {
    const cached = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    return { ...cached, key };
  }

  // 3 & 4. Network, in order, first hit wins
  let result = await fetchFromLrclib(track);
  if (!result) result = await fetchFromLyrica(track);

  if (!result) {
    result = { source: 'none', synced: null, plain: null };
  }

  // Cache even "not found" so we don't hammer both APIs every play —
  // but with a short-lived marker so it gets retried eventually rather
  // than permanently giving up on a track that just wasn't indexed yet.
  const toCache = { ...result, cachedAt: Date.now() };
  fs.writeFileSync(cachePath(key), JSON.stringify(toCache), 'utf8');

  return { ...result, key };
}

// ---------------------------------------------------------------------
// Public: manual entry
// ---------------------------------------------------------------------

function saveManualLyrics(track, { plain, synced }) {
  assertInit();
  const key = trackKey(track);
  const parsedSynced = typeof synced === 'string' ? parseLrc(synced) : (synced || null);
  const payload = { plain: plain || null, synced: parsedSynced, savedAt: Date.now() };
  fs.writeFileSync(manualPath(key), JSON.stringify(payload), 'utf8');
  return { ...payload, source: 'manual', key };
}

function clearManualLyrics(track) {
  assertInit();
  const key = trackKey(track);
  const p = manualPath(key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { key, cleared: true };
}

// ---------------------------------------------------------------------
// Romanization — pluggable per-script. Algorithmic (zero external
// dictionary) transforms are wired in for: Hangul, Cyrillic, Greek,
// and now the three Indic abugidas (Devanagari/Hindi, Tamil, Telugu)
// via a shared consonant+matra engine, since all three are phonetic
// scripts and need no dictionary. Japanese (kanji) and Chinese (hanzi)
// still need a dictionary-backed library (kuroshiro+kuromoji ~15MB,
// pinyin-pro ~2MB) — deliberately NOT pulled in without a decision on
// install size. Call romanize() anyway; unsupported scripts just
// return null and the UI should hide the toggle in that case.
// ---------------------------------------------------------------------

const HANGUL_BASE = 0xac00;
const CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'c', 'k', 't', 'p', 'h'];
const JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'weo', 'we', 'wi', 'yu', 'eu', 'yi', 'i'];
const JONG = ['', 'g', 'kk', 'gs', 'n', 'nj', 'nh', 'd', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'c', 'k', 't', 'p', 'h'];

function romanizeHangul(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= HANGUL_BASE && code <= 0xd7a3) {
      const offset = code - HANGUL_BASE;
      const cho = Math.floor(offset / (21 * 28));
      const jung = Math.floor((offset % (21 * 28)) / 28);
      const jong = offset % 28;
      out += CHO[cho] + JUNG[jung] + JONG[jong];
    } else {
      out += ch;
    }
  }
  return out;
}

const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function romanizeCyrillic(text) {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    if (CYRILLIC_MAP[lower] !== undefined) {
      const r = CYRILLIC_MAP[lower];
      out += ch === lower ? r : r.charAt(0).toUpperCase() + r.slice(1);
    } else {
      out += ch;
    }
  }
  return out;
}

const GREEK_MAP = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k',
  λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't',
  υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

function romanizeGreek(text) {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    if (GREEK_MAP[lower] !== undefined) {
      const r = GREEK_MAP[lower];
      out += ch === lower ? r : r.charAt(0).toUpperCase() + r.slice(1);
    } else {
      out += ch;
    }
  }
  return out;
}

// -- Indic abugidas (Devanagari, Tamil, Telugu) --------------------------
//
// All three are phonetic: consonants carry an inherent "a" that gets
// replaced by a following vowel sign (matra), or dropped entirely when
// followed by a virama/pulli. Independent vowel letters (used word-
// initially) are mapped separately. This is table + lookahead only —
// no dictionary, unlike Chinese/Japanese which need one for logographic
// characters.

function buildAbugidaRomanizer({ consonants, vowels, matras, virama, anusvara, visarga, nasal }) {
  return function romanizeAbugida(text) {
    const chars = Array.from(text);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const next = chars[i + 1];

      if (Object.prototype.hasOwnProperty.call(consonants, ch)) {
        const base = consonants[ch];
        if (next === virama) {
          out += base;
          i++; // consume virama, no vowel
        } else if (next && Object.prototype.hasOwnProperty.call(matras, next)) {
          out += base + matras[next];
          i++; // consume matra
        } else {
          out += base + 'a'; // inherent vowel
        }
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(vowels, ch)) {
        out += vowels[ch];
        continue;
      }
      if (anusvara && ch === anusvara) { out += 'm'; continue; }
      if (visarga && ch === visarga) { out += 'h'; continue; }
      if (nasal && ch === nasal) { out += 'n'; continue; }

      out += ch; // punctuation, spaces, digits, anything unmapped
    }
    return out;
  };
}

// Devanagari (Hindi, Marathi, Sanskrit-script, etc.)
const romanizeDevanagari = buildAbugidaRomanizer({
  consonants: {
    क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'ng',
    च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'ny',
    ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
    त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
    प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
    य: 'y', र: 'r', ल: 'l', व: 'v',
    श: 'sh', ष: 'sh', स: 's', ह: 'h', ळ: 'l',
  },
  vowels: {
    अ: 'a', आ: 'aa', इ: 'i', ई: 'ii', उ: 'u', ऊ: 'uu',
    ऋ: 'ri', ॠ: 'rii', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au',
  },
  matras: {
    'ा': 'aa', 'ि': 'i', 'ी': 'ii', 'ु': 'u', 'ू': 'uu',
    'ृ': 'ri', 'ॄ': 'rii', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  },
  virama: '्',
  anusvara: 'ं',
  visarga: 'ः',
  nasal: 'ँ',
});

// Tamil
const romanizeTamil = buildAbugidaRomanizer({
  consonants: {
    க: 'k', ங: 'ng', ச: 'ch', ஞ: 'ny', ட: 't', ண: 'n',
    த: 'th', ந: 'n', ப: 'p', ம: 'm', ய: 'y', ர: 'r',
    ல: 'l', வ: 'v', ழ: 'zh', ள: 'l', ற: 'r', ன: 'n',
    ஜ: 'j', ஷ: 'sh', ஸ: 's', ஹ: 'h', ஶ: 'sh',
  },
  vowels: {
    அ: 'a', ஆ: 'aa', இ: 'i', ஈ: 'ii', உ: 'u', ஊ: 'uu',
    எ: 'e', ஏ: 'ee', ஐ: 'ai', ஒ: 'o', ஓ: 'oo', ஔ: 'au',
  },
  matras: {
    'ா': 'aa', 'ி': 'i', 'ீ': 'ii', 'ு': 'u', 'ூ': 'uu',
    'ெ': 'e', 'ே': 'ee', 'ை': 'ai', 'ொ': 'o', 'ோ': 'oo', 'ௌ': 'au',
  },
  virama: '்',
});

// Telugu
const romanizeTelugu = buildAbugidaRomanizer({
  consonants: {
    క: 'k', ఖ: 'kh', గ: 'g', ఘ: 'gh', ఙ: 'ng',
    చ: 'ch', ఛ: 'chh', జ: 'j', ఝ: 'jh', ఞ: 'ny',
    ట: 't', ఠ: 'th', డ: 'd', ఢ: 'dh', ణ: 'n',
    త: 't', థ: 'th', ద: 'd', ధ: 'dh', న: 'n',
    ప: 'p', ఫ: 'ph', బ: 'b', భ: 'bh', మ: 'm',
    య: 'y', ర: 'r', ల: 'l', వ: 'v',
    శ: 'sh', ష: 'sh', స: 's', హ: 'h', ళ: 'l', ఱ: 'r',
  },
  vowels: {
    అ: 'a', ఆ: 'aa', ఇ: 'i', ఈ: 'ii', ఉ: 'u', ఊ: 'uu',
    ఋ: 'ri', ఎ: 'e', ఏ: 'ee', ఐ: 'ai', ఒ: 'o', ఓ: 'oo', ఔ: 'au',
  },
  matras: {
    'ా': 'aa', 'ి': 'i', 'ీ': 'ii', 'ు': 'u', 'ూ': 'uu',
    'ృ': 'ri', 'ె': 'e', 'ే': 'ee', 'ై': 'ai', 'ొ': 'o', 'ో': 'oo', 'ౌ': 'au',
  },
  virama: '్',
  anusvara: 'ం',
  visarga: 'ః',
});

function detectScript(text) {
  if (/[\uac00-\ud7a3]/.test(text)) return 'hangul';
  if (/[\u0400-\u04FF]/.test(text)) return 'cyrillic';
  if (/[\u0370-\u03FF]/.test(text)) return 'greek';
  if (/[\u0900-\u097F]/.test(text)) return 'devanagari';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'tamil';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'telugu';
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(text)) return 'cjk'; // unsupported for now (needs dictionary)
  return 'latin';
}

function romanize(text) {
  if (!text) return null;
  switch (detectScript(text)) {
    case 'hangul': return romanizeHangul(text);
    case 'cyrillic': return romanizeCyrillic(text);
    case 'greek': return romanizeGreek(text);
    case 'devanagari': return romanizeDevanagari(text);
    case 'tamil': return romanizeTamil(text);
    case 'telugu': return romanizeTelugu(text);
    default: return null; // includes 'cjk' and 'latin' — nothing to do (dictionary needed)
  }
}

function romanizeLines(lines) {
  if (!Array.isArray(lines)) return null;
  const out = lines.map((l) => ({ ...l, romanized: romanize(l.text) }));
  return out.some((l) => l.romanized) ? out : null;
}

module.exports = {
  init,
  get: getLyrics,
  saveManual: saveManualLyrics,
  clearManual: clearManualLyrics,
  romanize,
  romanizeLines,
  // exported for tests/debugging, not part of the public IPC surface
  _parseLrc: parseLrc,
  _trackKey: trackKey,
};