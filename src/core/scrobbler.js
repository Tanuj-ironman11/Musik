// src/core/scrobbler.js
//
// Last.fm scrobbling. Main-process only. Session key lives in
// userData/scrobble-auth.json, written via Node's fs, same pattern as
// theme.json in main.js.
//
// User-supplied API key/secret are deliberately NOT written to that file —
// they live only in renderer localStorage (settings.js) and get pushed
// into this module's memory via setCredentials() on app boot and whenever
// the user edits them in Settings. That keeps a personal Last.fm API secret
// out of any file that could end up committed or shared between sessions —
// it only ever exists in-memory here and in the user's own browser storage.
//
// Last.fm's REST API (https://www.last.fm/api) requires every call to be
// signed: params sorted alphabetically by key, concatenated as key+value
// with no separators, secret appended, then md5'd. That signature travels
// as api_sig on every request, auth or not.
//
// Flow:
//   1. getAuthUrl()      -> renderer opens this in the system browser
//   2. user approves on last.fm's site, which redirects with ?token=...
//      Settled: manual paste-token flow (no protocol handler) — least
//      moving parts, no per-OS registration for the Mac build to trip on.
//   3. completeAuth(token) -> exchanges token for a permanent session key,
//      persists it, scrobbling is live from then on
//
// Once authed:
//   updateNowPlaying(track) — call the moment a track starts
//   scrobble(track)         — call once playback crosses the threshold
//                              (caller owns the timing; see player-ui.js)
//
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Baked-in shared API key/secret so scrobbling works out of the box without
// every user registering their own Last.fm API app — same approach as the
// old codebase per project notes.
//
// The actual values live in lastfm-secrets.json, a sibling file that's
// gitignored (never committed, never in GitHub history) but listed in
// package.json's build.files so electron-builder still bundles it into
// every packaged .exe — same pattern already used for the wasapi-loopback
// native addon. If that file's missing (e.g. a fresh clone that hasn't
// been given one yet), we fall back to empty strings and scrobbling just
// stays disabled until it exists, same as before.
function loadDefaultCredentials() {
  try {
    const p = path.join(__dirname, 'lastfm-secrets.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { apiKey: parsed.apiKey || '', apiSecret: parsed.apiSecret || '' };
    }
  } catch (err) {
    console.warn('[Musik] scrobbler: failed to read lastfm-secrets.json:', err.message);
  }
  return { apiKey: '', apiSecret: '' };
}
const { apiKey: DEFAULT_API_KEY, apiSecret: DEFAULT_API_SECRET } = loadDefaultCredentials();

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

let authPath = null;
let auth = {
  apiKey: null,       // user override, falls back to DEFAULT_API_KEY
  apiSecret: null,     // user override, falls back to DEFAULT_API_SECRET
  sessionKey: null,
  username: null,
  enabled: true,
  lastScrobbleAt: null, // unix ms of most recent successful scrobble() call
};

// Tracks the last track we sent now-playing for, so scrobble() can't fire
// for a track that was swapped out before it ever got its now-playing call.
let lastNowPlayingKey = null;

function loadAuth() {
  if (!authPath || !fs.existsSync(authPath)) return;
  try {
    const stored = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    auth = { ...auth, ...stored };
  } catch (err) {
    console.warn('[Musik] scrobbler: failed to read scrobble-auth.json:', err.message);
  }
}

// Persists everything except apiKey/apiSecret — those are memory-only
// (see header note) and must never land in this file on disk.
function persistAuth() {
  if (!authPath) return;
  const { apiKey, apiSecret, ...persisted } = auth;
  fs.writeFileSync(authPath, JSON.stringify(persisted, null, 2));
}

function init(userDataPath) {
  authPath = path.join(userDataPath, 'scrobble-auth.json');
  loadAuth();
}

function apiKey() {
  return auth.apiKey || DEFAULT_API_KEY;
}
function apiSecret() {
  return auth.apiSecret || DEFAULT_API_SECRET;
}

// Alphabetical key order, key+value concatenated with no delimiter,
// secret appended, md5 hex digest. Per Last.fm's signing spec.
// format/callback are excluded from the signature — signing them produces
// error code 13 ("invalid signature") on every authenticated call.
function sign(params) {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  let base = '';
  for (const k of keys) base += k + params[k];
  base += apiSecret();
  return crypto.createHash('md5').update(base, 'utf-8').digest('hex');
}

async function call(method, params, { post = false } = {}) {
  if (!apiKey()) {
    throw new Error('Last.fm API key missing — set one in Settings or bake in DEFAULT_API_KEY');
  }

  const allParams = { ...params, method, api_key: apiKey(), format: 'json' };
  for (const k of Object.keys(allParams)) {
    if (allParams[k] === undefined) delete allParams[k];
  }
  allParams.api_sig = sign(allParams);

  let res;
  if (post) {
    const body = new URLSearchParams(allParams);
    res = await fetch(API_ROOT, { method: 'POST', body });
  } else {
    const qs = new URLSearchParams(allParams);
    res = await fetch(`${API_ROOT}?${qs}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  }
  return data;
}

// --- Auth handshake ---------------------------------------------------------

// Holds the token between getAuthUrl() and completeAuth() — desktop auth
// flow needs a real auth.getToken call up front (unsigned; Last.fm rejects
// a signed getToken call the same way it rejects an unsigned getSession),
// then the user visits getAuthUrl()'s returned URL to approve it in their
// browser, then completeAuth() exchanges that same token for a session key.
let pendingToken = null;

async function getAuthUrl() {
  const qs = new URLSearchParams({ method: 'auth.getToken', api_key: apiKey(), format: 'json' });
  const res = await fetch(`${API_ROOT}?${qs}`);
  const data = await res.json();
  if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);

  pendingToken = data.token;
  // Renderer opens this via shell.openExternal — user approves in their
  // real browser, then comes back and clicks "I've approved it" (no
  // redirect/callback handler needed for the desktop flow).
  return `https://www.last.fm/api/auth/?api_key=${apiKey()}&token=${encodeURIComponent(pendingToken)}`;
}

async function completeAuth() {
  if (!pendingToken) throw new Error('No pending Last.fm authorization — click Connect first');
  const data = await call('auth.getSession', { token: pendingToken });
  pendingToken = null;
  auth.sessionKey = data.session.key;
  auth.username = data.session.name;
  persistAuth();
  return { username: auth.username };
}

function disconnect() {
  auth.sessionKey = null;
  auth.username = null;
  auth.lastScrobbleAt = null;
  pendingToken = null;
  persistAuth();
  return true;
}

// --- Settings / credentials --------------------------------------------------

function getSettings() {
  return {
    connected: !!auth.sessionKey,
    username: auth.username,
    enabled: auth.enabled,
    usingCustomApiKey: !!auth.apiKey,
    lastScrobbleAt: auth.lastScrobbleAt,
  };
}

// creds: { apiKey?, apiSecret?, enabled? } — API key/secret are optional
// overrides of the baked-in shared credentials; enabled is the user's
// scrobbling on/off toggle (kept separate from "connected" — someone can
// be authed and still pause scrobbling temporarily).
function setCredentials(creds = {}) {
  if (typeof creds.apiKey === 'string') auth.apiKey = creds.apiKey || null;
  if (typeof creds.apiSecret === 'string') auth.apiSecret = creds.apiSecret || null;
  if (typeof creds.enabled === 'boolean') auth.enabled = creds.enabled;
  persistAuth();
  return getSettings();
}

// --- Scrobbling actions ------------------------------------------------------

function trackKey(track) {
  return `${track.artist ?? ''}::${track.title ?? ''}::${track.filePath ?? ''}`;
}

async function updateNowPlaying(track) {
  if (!auth.enabled || !auth.sessionKey || !track?.title || !track?.artist) return null;
  lastNowPlayingKey = trackKey(track);
  try {
    return await call(
      'track.updateNowPlaying',
      {
        track: track.title,
        artist: track.artist,
        album: track.album || '',
        duration: track.duration ? Math.round(track.duration) : undefined,
        sk: auth.sessionKey,
      },
      { post: true }
    );
  } catch (err) {
    console.warn('[Musik] scrobbler: now-playing failed:', err.message);
    return null;
  }
}

// timestamp: unix seconds the track STARTED playing (Last.fm wants this,
// not "now") — caller should capture it at trackupdate time and pass it
// back in here.
async function scrobble(track, timestamp) {
  if (!auth.enabled || !auth.sessionKey || !track?.title || !track?.artist) return null;
  // Guard against scrobbling a track that was skipped before its own
  // now-playing call ever landed (e.g. rapid-skip through a queue).
  if (lastNowPlayingKey !== trackKey(track)) return null;

  try {
    const result = await call(
      'track.scrobble',
      {
        'track': track.title,
        'artist': track.artist,
        'album': track.album || '',
        'timestamp': timestamp,
        'sk': auth.sessionKey,
      },
      { post: true }
    );
    auth.lastScrobbleAt = Date.now();
    persistAuth();
    return result;
  } catch (err) {
    console.warn('[Musik] scrobbler: scrobble failed:', err.message);
    return null;
  }
}

// Unsigned public GET — mirrors getAuthUrl()'s raw-fetch approach rather
// than routing through call() (which always signs). user.getInfo/getTop*
// are public, unauthenticated read methods; signing isn't required and
// per this file's own scars with auth.getToken rejecting a signed call,
// safest to just not sign anything that doesn't need it.
async function publicCall(method, params = {}) {
  const qs = new URLSearchParams({ ...params, method, api_key: apiKey(), format: 'json' });
  const res = await fetch(`${API_ROOT}?${qs}`);
  const data = await res.json();
  if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  return data;
}

// Backs the Profile tab's lifetime stats once Last.fm is connected. Pulls
// ALL-TIME totals from Last.fm (user.getInfo's playcount is the user's
// entire scrobble history, not scoped to when they connected Musik — that's
// fine, it's the richer source once available). Returns null on any
// failure so callers can fall back to local stats.js numbers instead.
async function getLifetimeLastfmStats() {
  if (!auth.username) return null;
  try {
    const [info, artists, albums, tracks] = await Promise.all([
      publicCall('user.getInfo', { user: auth.username }),
      publicCall('user.getTopArtists', { user: auth.username, period: 'overall', limit: 10 }),
      publicCall('user.getTopAlbums', { user: auth.username, period: 'overall', limit: 10 }),
      publicCall('user.getTopTracks', { user: auth.username, period: 'overall', limit: 10 }),
    ]);

    const artistList = artists?.topartists?.artist ?? [];
    const albumList = albums?.topalbums?.album ?? [];
    const trackList = tracks?.toptracks?.track ?? [];

    return {
      totalPlays: Number(info?.user?.playcount) || 0,
      topArtists: artistList.map((a) => ({ key: a.name, count: Number(a.playcount) || 0 })),
      topAlbums: albumList.map((a) => ({ key: `${a.artist?.name || ''}::${a.name}`, count: Number(a.playcount) || 0 })),
      topTracks: trackList.map((t) => ({ key: `${t.artist?.name || ''}::${t.name}`, count: Number(t.playcount) || 0 })),
    };
  } catch (err) {
    console.warn('[Musik] scrobbler: getLifetimeLastfmStats failed:', err.message);
    return null;
  }
}

module.exports = {
  init,
  getAuthUrl,
  completeAuth,
  disconnect,
  getSettings,
  setCredentials,
  updateNowPlaying,
  scrobble,
  getLifetimeLastfmStats,
};
