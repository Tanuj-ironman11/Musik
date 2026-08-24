// src/core/art-provider.js
// Main-process module. CommonJS, loaded via require() in main.js.
//
// window.Musik.art.extract(filePath)      -> re-pull embedded art on demand
// window.Musik.art.fetchOnline(trackMeta) -> online fallback when a file has no embedded art
//
// Data contract (locked): artData is always { format: string, base64: string }
// never a raw string, never without a MIME type.

const mm = require('music-metadata'); // pinned to 7.14.0 — do not upgrade, breaks FLAC

// --- Embedded-art extraction -----------------------------------------------

async function extract(filePath) {
  if (!filePath) return null;

  try {
    const metadata = await mm.parseFile(filePath, { skipCovers: false });
    const pic = metadata?.common?.picture?.[0];
    if (!pic || !pic.data) return null;

    const buf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);

    return {
      format: pic.format || 'image/jpeg',
      base64: buf.toString('base64'),
    };
  } catch (err) {
    console.warn(`[Musik] art-provider: extract failed for "${filePath}":`, err.message);
    return null;
  }
}

// --- Online fallback (MusicBrainz + Cover Art Archive, no API key) --------

async function fetchOnline(trackMeta) {
  const artist = trackMeta?.artist?.trim();
  const album = trackMeta?.album?.trim();
  if (!artist || !album) return null;

  try {
    const query = encodeURIComponent(`artist:"${artist}" AND release:"${album}"`);
    const searchRes = await fetch(
      `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=1`,
      { headers: { 'User-Agent': 'Musik/1.0 (https://github.com/) ' } }
    );
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const releaseId = searchData?.releases?.[0]?.id;
    if (!releaseId) return null;

    const artRes = await fetch(`https://coverartarchive.org/release/${releaseId}/front`);
    if (!artRes.ok) return null; // 404 = no art on file for this release, not an error

    const contentType = artRes.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await artRes.arrayBuffer();

    return {
      format: contentType,
      base64: Buffer.from(arrayBuffer).toString('base64'),
    };
  } catch (err) {
    console.warn(`[Musik] art-provider: fetchOnline failed for "${artist} - ${album}":`, err.message);
    return null;
  }
}

module.exports = { extract, fetchOnline };
