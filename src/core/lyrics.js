// src/core/lyrics.js
//
// Main-process lyrics resolution. CommonJS, same init(userDataPath) +
// disk-cache pattern as library.js.
//
// Resolution order per track: manual override > disk cache > NetEase
// klyric (word-level) > LRCLIB (synced+plain) > Lyrica (prehosted
// fallback, see Mac/Windows discrepancy note in the project brief).
// Musixmatch richsync was removed (ToS) — do not reintroduce.
//
// Track keys are artist+title only (album dropped — it drifted between
// reads and orphaned manual files; see legacyTrackKey/migration below).
//
// romanize()/romanizeLines() are async (Japanese/Chinese need dictionary
// lookups; every other script is sync but wrapped the same way so callers
// don't branch).
//
// IPC wiring (main.js + preload.js) is NOT in this file — new surface:
// lyrics-get, lyrics-save-manual, lyrics-clear-manual, lyrics-romanize.

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

function trackKey({ artist, title }) {
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const raw = `${norm(artist)}::${norm(title)}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// Old key format (artist+title+album), kept only so pre-existing manual
// files get migrated once in getLyrics() instead of orphaned. New saves
// always use the album-free key above.
function legacyTrackKey({ artist, title, album }) {
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

function httpGetJson(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { 'User-Agent': 'Musik/1.0', ...extraHeaders } }, (res) => {
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
      // this base is down/cold/rate-limited — try the next one
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Source: NetEase Cloud Music klyric (word-level). No auth needed.
// Format: [lineStartMs,lineDurationMs]word(offsetMs,durationMs)word(...)...
// Best-effort parsing of the commonly-documented format.
// ---------------------------------------------------------------------

const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web';
const NETEASE_LYRIC = 'https://music.163.com/api/song/lyric';

async function fetchFromNetease({ artist, title }) {
  try {
    const neteaseHeaders = { Referer: 'https://music.163.com' };
    const q = new URLSearchParams({ s: `${title || ''} ${artist || ''}`.trim(), type: '1', limit: '3' });
    const searchData = await httpGetJson(`${NETEASE_SEARCH}?${q.toString()}`, neteaseHeaders);
    const songId = searchData?.result?.songs?.[0]?.id;
    if (!songId) return null;

    const lyricParams = new URLSearchParams({ os: 'pc', id: String(songId), lv: '-1', kv: '-1', tv: '-1' });
    const lyricData = await httpGetJson(`${NETEASE_LYRIC}?${lyricParams.toString()}`, neteaseHeaders);
    const klyric = lyricData?.klyric?.lyric;
    if (!klyric) return null;

    const words = [];
    const lineRe = /^\[(\d+),(\d+)\](.*)$/;
    const wordRe = /([^(]+)\((\d+),(\d+)\)/g;
    for (const raw of klyric.split(/\r?\n/)) {
      const lineMatch = raw.match(lineRe);
      if (!lineMatch) continue;
      const [, lineStart, , rest] = lineMatch;
      let m;
      while ((m = wordRe.exec(rest)) !== null) {
        const [, text, offset, dur] = m;
        if (!text.trim()) continue;
        const startMs = Number(lineStart) + Number(offset);
        words.push({ text: text.trim(), startMs, endMs: startMs + Number(dur) });
      }
    }

    if (words.length) {
      const plainLrc = lyricData?.lrc?.lyric || null;
      return {
        source: 'netease',
        words,
        synced: parseLrc(plainLrc),
        plain: plainLrc ? plainLrc.replace(/\[[^\]]*\]/g, '').trim() : null,
      };
    }
  } catch (_) {
    // search miss, no klyric for this song, or format drift — fall through
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

  // 1b. One-time migration from the old album-inclusive key.
  const legacyKey = legacyTrackKey(track);
  if (legacyKey !== key && fs.existsSync(manualPath(legacyKey))) {
    const manual = JSON.parse(fs.readFileSync(manualPath(legacyKey), 'utf8'));
    fs.writeFileSync(manualPath(key), JSON.stringify(manual), 'utf8');
    fs.unlinkSync(manualPath(legacyKey));
    return { ...manual, source: 'manual', key };
  }

  // 2. Disk cache
  if (fs.existsSync(cachePath(key))) {
    const cached = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    return { ...cached, key };
  }

  // 3-5. Network, in order, first hit wins. NetEase tried first since
  // it's the remaining word-level source; line-level sources remain as
  // fallbacks so coverage doesn't regress for tracks/languages NetEase
  // doesn't have. (Musixmatch removed — ToS reasons, don't reintroduce.)
  let result = await fetchFromNetease(track);
  if (!result) result = await fetchFromLrclib(track);
  if (!result) result = await fetchFromLyrica(track);

  if (!result) {
    result = { source: 'none', synced: null, plain: null, words: null };
  }

  // Cache "not found" too, so we're not hammering every source on every
  // play, but it'll still get retried on a later play (see cachedAt).
  const toCache = { ...result, cachedAt: Date.now() };
  fs.writeFileSync(cachePath(key), JSON.stringify(toCache), 'utf8');

  return { ...result, key };
}

// ---------------------------------------------------------------------
// Public: manual entry
// ---------------------------------------------------------------------

function saveManualLyrics(track, { plain, synced, words }) {
  assertInit();
  if (!fs.existsSync(manualDir)) fs.mkdirSync(manualDir, { recursive: true });
  const key = trackKey(track);
  const parsedSynced = typeof synced === 'string' ? parseLrc(synced) : (synced || null);
  // words: optional word-level rich sync, [{ text, startMs, endMs }, ...] —
  // same shape fetchFromNetease returns, so the UI doesn't branch by source.
  const payload = { plain: plain || null, synced: parsedSynced, words: words || null, savedAt: Date.now() };
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
// Romanization — pluggable per-script. Hangul, Cyrillic, Greek, and the
// Indic abugidas (Devanagari/Tamil/Telugu/Gurmukhi) are algorithmic, no
// dictionary needed. Japanese/Chinese need a dictionary lib (kuroshiro+
// kuromoji, pinyin-pro) — optional deps, see getKuroshiro(). Unsupported
// scripts just return null; the UI hides the toggle in that case.
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

// -- Indic abugidas (Devanagari, Tamil, Telugu, Gurmukhi) ----------------
//
// Phonetic: consonants carry an inherent "a" that a following vowel sign
// (matra) replaces, or that drops entirely before a virama/pulli.
// Table + lookahead only, no dictionary needed.

function buildAbugidaRomanizer({ consonants, vowels, matras, virama, anusvara, anusvaraMap, visarga, nasal, nukta, nuktaMap, addak }) {
  const anusvaraChars = Array.isArray(anusvara) ? anusvara : (anusvara ? [anusvara] : []);
  return function romanizeAbugida(text) {
    const chars = Array.from(text);
    let out = '';
    let pendingGeminate = false; // set by addak (Gurmukhi gemination mark) — doubles the NEXT consonant
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      let next = chars[i + 1];

      if (addak && ch === addak) { pendingGeminate = true; continue; }

      if (Object.prototype.hasOwnProperty.call(consonants, ch)) {
        // Nukta (combining dot, swaps a consonant for a borrowed sound e.g.
        // ज+nukta -> ज़ "za") must resolve before virama/matra lookahead.
        let base = consonants[ch];
        if (nukta && next === nukta && nuktaMap && Object.prototype.hasOwnProperty.call(nuktaMap, ch)) {
          base = nuktaMap[ch];
          i++; // consume nukta
          next = chars[i + 1]; // re-check what comes after the nukta
        }
        if (pendingGeminate) { base += base; pendingGeminate = false; }

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
      if (anusvaraChars.includes(ch)) {
        // Nasalization sound depends on the following consonant (labial ->
        // m, dental/alveolar -> n, velar -> ng) — not a flat 'm'.
        const followingChar = chars[i + 1];
        out += (anusvaraMap && followingChar && anusvaraMap[followingChar]) || 'n';
        continue;
      }
      if (visarga && ch === visarga) { out += 'h'; continue; }
      if (nasal && ch === nasal) { out += 'n'; continue; }
      if (nukta && ch === nukta) continue; // stray/unmatched nukta — drop, don't leak into output

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
  anusvaraMap: {
    // velar (क-वर्ग) -> ng
    क: 'ng', ख: 'ng', ग: 'ng', घ: 'ng', ङ: 'ng',
    // palatal (च-वर्ग) -> n
    च: 'n', छ: 'n', ज: 'n', झ: 'n', ञ: 'n',
    // retroflex (ट-वर्ग) -> n
    ट: 'n', ठ: 'n', ड: 'n', ढ: 'n', ण: 'n',
    // dental (त-वर्ग) -> n
    त: 'n', थ: 'n', द: 'n', ध: 'n', न: 'n',
    // labial (प-वर्ग) -> m
    प: 'm', फ: 'm', ब: 'm', भ: 'm', म: 'm',
  },
  visarga: 'ः',
  nasal: 'ँ',
  nukta: '़',
  nuktaMap: {
    क: 'q', ख: 'kh', ग: 'gh', ज: 'z', ड: 'r', ढ: 'rh', फ: 'f', य: 'y',
  },
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
  anusvaraMap: {
    క: 'ng', ఖ: 'ng', గ: 'ng', ఘ: 'ng', ఙ: 'ng',
    చ: 'n', ఛ: 'n', జ: 'n', ఝ: 'n', ఞ: 'n',
    ట: 'n', ఠ: 'n', డ: 'n', ఢ: 'n', ణ: 'n',
    త: 'n', థ: 'n', ద: 'n', ధ: 'n', న: 'n',
    ప: 'm', ఫ: 'm', బ: 'm', భ: 'm', మ: 'm',
  },
  visarga: 'ః',
});

// Gurmukhi (Punjabi) — same structural layout as Devanagari (Unicode block
// mirrors it: U+0A00-U+0A7F vs U+0900-U+097F). Nukta-derived letters (ਖ਼ ਗ਼
// ਜ਼ ਫ਼) are listed directly in `consonants` since real-world text uses
// their precomposed codepoints rather than base+combining-nukta.
const romanizeGurmukhi = buildAbugidaRomanizer({
  consonants: {
    ਕ: 'k', ਖ: 'kh', ਗ: 'g', ਘ: 'gh', ਙ: 'ng',
    ਚ: 'ch', ਛ: 'chh', ਜ: 'j', ਝ: 'jh', ਞ: 'ny',
    ਟ: 't', ਠ: 'th', ਡ: 'd', ਢ: 'dh', ਣ: 'n',
    ਤ: 't', ਥ: 'th', ਦ: 'd', ਧ: 'dh', ਨ: 'n',
    ਪ: 'p', ਫ: 'ph', ਬ: 'b', ਭ: 'bh', ਮ: 'm',
    ਯ: 'y', ਰ: 'r', ਲ: 'l', ਵ: 'v', ੜ: 'r',
    ਸ: 's', ਹ: 'h',
    // precomposed nukta-derived letters (see confidence note above)
    ਖ਼: 'kh', ਗ਼: 'gh', ਜ਼: 'z', ਫ਼: 'f', ਸ਼: 'sh',
  },
  vowels: {
    ਅ: 'a', ਆ: 'aa', ਇ: 'i', ਈ: 'ii', ਉ: 'u', ਊ: 'uu',
    ਏ: 'e', ਐ: 'ai', ਓ: 'o', ਔ: 'au',
  },
  matras: {
    'ਾ': 'aa', 'ਿ': 'i', 'ੀ': 'ii', 'ੁ': 'u', 'ੂ': 'uu',
    'ੇ': 'e', 'ੈ': 'ai', 'ੋ': 'o', 'ੌ': 'au',
  },
  virama: '੍',
  anusvara: ['ਂ', 'ੰ'], // bindi + tippi — both nasalize, treated identically here
  anusvaraMap: {
    ਕ: 'ng', ਖ: 'ng', ਗ: 'ng', ਘ: 'ng', ਙ: 'ng',
    ਚ: 'n', ਛ: 'n', ਜ: 'n', ਝ: 'n', ਞ: 'n',
    ਟ: 'n', ਠ: 'n', ਡ: 'n', ਢ: 'n', ਣ: 'n',
    ਤ: 'n', ਥ: 'n', ਦ: 'n', ਧ: 'n', ਨ: 'n',
    ਪ: 'm', ਫ: 'm', ਬ: 'm', ਭ: 'm', ਮ: 'm',
  },
  addak: 'ੱ', // gemination mark — doubles the consonant right after it
});

// Kana presence tells Japanese apart from Chinese (both use CJK ideographs,
// only Japanese mixes in kana). Heuristic, not real language detection — a
// kanji-only line with zero kana would misroute to pinyin. Good enough.
const KANA_RE = /[\u3040-\u30FF]/;
const CJK_IDEOGRAPH_RE = /[\u4E00-\u9FFF]/;

function detectScript(text) {
  if (/[\uac00-\ud7a3]/.test(text)) return 'hangul';
  if (/[\u0400-\u04FF]/.test(text)) return 'cyrillic';
  if (/[\u0370-\u03FF]/.test(text)) return 'greek';
  if (/[\u0900-\u097F]/.test(text)) return 'devanagari';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'tamil';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'telugu';
  if (/[\u0A00-\u0A7F]/.test(text)) return 'gurmukhi';
  if (KANA_RE.test(text) || CJK_IDEOGRAPH_RE.test(text)) {
    return KANA_RE.test(text) ? 'japanese' : 'chinese';
  }
  return 'latin';
}

// ---------------------------------------------------------------------
// Japanese (kuroshiro + kuromoji) and Chinese (pinyin-pro) — dictionary-
// backed, optional deps (npm install kuroshiro kuroshiro-analyzer-kuromoji
// pinyin-pro). Not installed = romanize() returns null for that script,
// UI hides the toggle, no crash.
//
// PACKAGING TODO (not done here): kuromoji's dict directory needs
// electron-builder asarUnpack, same concern as the WASAPI .node addon —
// if that's not set up yet, JP romanization will silently fail in a
// packaged build even though it works fine in dev.
// ---------------------------------------------------------------------

let kuroshiroInitPromise = null;

// NOTE: no sticky "give up forever" flag here anymore. A previous version
// cached init failure permanently for the whole app session, so one bad
// init (cold start, dict path race, whatever) silently killed JP
// romanization for every song after it — this is almost certainly what
// caused the "romanize button works sometimes" reports. Now every call
// with no live instance just retries.
async function getKuroshiro() {
  if (!kuroshiroInitPromise) {
    kuroshiroInitPromise = (async () => {
      const Kuroshiro = require('kuroshiro').default || require('kuroshiro');
      const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
      const instance = new Kuroshiro();
      await instance.init(new KuromojiAnalyzer());
      return instance;
    })().catch((err) => {
      console.warn('[Musik] lyrics: kuroshiro init failed, will retry next call.', err.message);
      kuroshiroInitPromise = null;
      return null;
    });
  }
  return kuroshiroInitPromise;
}

function romanizeChinese(text) {
  try {
    const { pinyin } = require('pinyin-pro');
    // Word-level lyric sources are often space-joined syllable tokens, not
    // real prose spacing — strip spaces so tone/word-boundary resolution
    // works, then let toneType/mode re-derive real spacing on output.
    return pinyin(text.replace(/\s+/g, ''), { toneType: 'none', type: 'string', nonZh: 'consecutive' });
  } catch (err) {
    console.warn('[Musik] lyrics: pinyin-pro unavailable, Chinese romanization disabled.', err.message);
    return null;
  }
}

async function romanizeJapanese(text) {
  const kuroshiro = await getKuroshiro();
  if (!kuroshiro) return null;
  try {
    // Word-level sources join syllables with spaces, which breaks
    // kuromoji's tokenizer (each chunk loses sentence context, single
    // kanji fail lookup). Strip spaces for conversion, mode:'spaced'
    // re-adds proper word spacing on the output.
    return await kuroshiro.convert(text.replace(/\s+/g, ''), { to: 'romaji', mode: 'spaced' });
  } catch (err) {
    console.warn('[Musik] lyrics: kuroshiro conversion failed for a line, skipping it.', err.message);
    return null;
  }
}

// Async so every script shares one call shape (only JP actually needs it).
// scriptHint, if given, skips detectScript entirely — used by
// romanizeWords() below so word-level tokens inherit their containing
// line's script instead of getting misdetected on their own tiny fragment
// (a kanji-only word with no kana in it, e.g. "渦巻" split out from
// "渦巻いて", looks identical to Chinese by the kana heuristic alone).
async function romanize(text, scriptHint) {
  if (!text) return null;
  switch (scriptHint || detectScript(text)) {
    case 'hangul': return romanizeHangul(text);
    case 'cyrillic': return romanizeCyrillic(text);
    case 'greek': return romanizeGreek(text);
    case 'devanagari': return romanizeDevanagari(text);
    case 'tamil': return romanizeTamil(text);
    case 'telugu': return romanizeTelugu(text);
    case 'gurmukhi': return romanizeGurmukhi(text);
    case 'chinese': return romanizeChinese(text);
    case 'japanese': return romanizeJapanese(text);
    default: return null; // 'latin' — nothing to do
  }
}

async function romanizeLines(lines) {
  if (!Array.isArray(lines)) return null;
  const out = await Promise.all(
    lines.map(async (l) => ({ ...l, romanized: await romanize(l.text) }))
  );
  return out.some((l) => l.romanized) ? out : null;
}

// Word-level rich sync needs a different pairing than romanizeLines: each
// word gets matched to its containing line (by timing). Japanese lines get
// romanized as a whole (see below) instead of per word — this source
// segments below real word/mora boundaries, so there's no reliable way to
// split a shared reading across word tokens. Every other script romanizes
// each word independently against the line's pinned script (those don't
// suffer Japanese's isolation/segmentation problem).
async function romanizeWords(words, lines) {
  if (!Array.isArray(words) || !Array.isArray(lines) || !lines.length) return null;

  // Bucket each word into the line it chronologically falls under. The old
  // ±25ms tolerance windows left a small gap between consecutive lines'
  // windows that a word could fall through, returning -1 — and the -1
  // fallback then used just that ONE orphaned word as "lineText" instead
  // of its real line, wiping out sentence context and recreating the
  // exact isolated-kanji bug (that's what 騒/濡/喰 showing up raw actually
  // was). Never returning -1 removes the gap: every word lands under the
  // last line whose start time it's at or past.
  const lineIndexForWord = words.map((w) => {
    let li = 0;
    for (let i = 0; i < lines.length; i++) {
      if (w.startMs >= lines[i].time * 1000) li = i;
      else break;
    }
    return li;
  });

  const byLine = new Map(); // lineIndex -> [wordIndex, ...], in original order
  lineIndexForWord.forEach((li, wi) => {
    if (!byLine.has(li)) byLine.set(li, []);
    byLine.get(li).push(wi);
  });

  const romanized = new Array(words.length).fill(null);

  for (const [li, wordIdxs] of byLine) {
    const lineText = lines[li].text;
    const script = detectScript(lineText);

    if (script === 'japanese') {
      // Per-word splitting for Japanese doesn't work here — this source
      // segments lyrics close to per-syllable, well below real word/mora
      // boundaries, so there's no reliable way to divide a shared
      // reading across word tokens. Romanize the whole line at once
      // instead (same proven path romanizeLines() uses) and surface it
      // once, on the line's first word, in sync with the line's start.
      const lineRomanized = await romanizeJapanese(lineText);
      wordIdxs.forEach((wi, k) => { romanized[wi] = k === 0 ? lineRomanized : ''; });
    } else {
      for (const wi of wordIdxs) {
        romanized[wi] = await romanize(words[wi].text, script);
      }
    }
  }

  const out = words.map((w, i) => ({ ...w, romanized: romanized[i] }));
  return out.some((w) => w.romanized) ? out : null;
}

module.exports = {
  init,
  get: getLyrics,
  saveManual: saveManualLyrics,
  clearManual: clearManualLyrics,
  romanize,
  romanizeLines,
  romanizeWords,
  // exported for tests/debugging, not part of the public IPC surface
  _parseLrc: parseLrc,
  _trackKey: trackKey,
};