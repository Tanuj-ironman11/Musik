// src/ui/accent-extractor.js
// Renderer-side. Samples decoded album art on a hidden canvas to get a
// dominant color, then rewrites --color-accent-* tokens on 'artupdate'.
// Emits 'accentupdate' { r, g, b, css } for mods that want to react to accent changes.

(function () {
  const FALLBACK_RGB = [61, 184, 245]; // matches tokens.css --color-accent-rgb default
  const SAMPLE_SIZE = 48;

  let canvas = null;
  let ctx = null;

  function getCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    return { canvas, ctx };
  }

  function extractDominantColor(imageData) {
    const data = imageData.data;
    const buckets = new Map();
    const STEP = 24;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;

      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lightness = (max + min) / 2;
      const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(2 * lightness - 255));

      if (lightness < 22 || lightness > 235) continue;
      if (saturation < 0.12 && (lightness < 40 || lightness > 200)) continue;

      const key = `${Math.floor(r / STEP)}-${Math.floor(g / STEP)}-${Math.floor(b / STEP)}`;
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, weight: 0 };
      bucket.r += r; bucket.g += g; bucket.b += b; bucket.count += 1;
      bucket.weight += 1 + saturation * 2;
      buckets.set(key, bucket);
    }

    if (!buckets.size) return null;

    let best = null;
    for (const bucket of buckets.values()) {
      if (!best || bucket.weight > best.weight) best = bucket;
    }

    return [
      Math.round(best.r / best.count),
      Math.round(best.g / best.count),
      Math.round(best.b / best.count),
    ];
  }

  // Keeps hue, clamps saturation/lightness into a readable accent range.
  function normalizeForAccent([r, g, b]) {
    let h, s, l;
    const rr = r / 255, gg = g / 255, bb = b / 255;
    const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
    l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case rr: h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6; break;
        case gg: h = ((bb - rr) / d + 2) / 6; break;
        default: h = ((rr - gg) / d + 4) / 6;
      }
    }

    s = Math.max(s, 0.45);
    l = Math.min(Math.max(l, 0.45), 0.68);

    return hslToRgb(h, s, l);
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [
      Math.round(hue2rgb(h + 1 / 3) * 255),
      Math.round(hue2rgb(h) * 255),
      Math.round(hue2rgb(h - 1 / 3) * 255),
    ];
  }

  let applyingAccent = false;

  function applyAccent([r, g, b]) {
    applyingAccent = true;

    const root = document.documentElement.style;
    const rgb = `${r}, ${g}, ${b}`;
    root.setProperty('--color-accent', `rgb(${rgb})`);
    root.setProperty('--color-accent-rgb', rgb);
    root.setProperty('--color-accent-glow', `rgba(${rgb}, 0.25)`);
    root.setProperty('--color-accent-subtle', `rgba(${rgb}, 0.10)`);
    root.setProperty('--color-accent-dim', `rgba(${rgb}, 0.06)`);

    // Sets vars directly rather than via window.Musik.theme.setVar, which
    // rebroadcasts on 'artupdate' and would cause a feedback loop.
    window.Musik?.events?.emit('accentupdate', { r, g, b, css: `rgb(${rgb})` });

    setTimeout(() => { applyingAccent = false; }, 0);
  }

  function resetToFallback() {
    applyAccent(FALLBACK_RGB);
  }

  async function handleArtUpdate(artData) {
    if (applyingAccent) return;

    if (!artData || !artData.base64 || !artData.format) {
      resetToFallback();
      return;
    }

    try {
      const img = new Image();
      const src = `data:${artData.format};base64,${artData.base64}`;

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = src;
      });

      const { canvas: c, ctx: cx } = getCanvas();
      cx.clearRect(0, 0, c.width, c.height);
      cx.drawImage(img, 0, 0, c.width, c.height);

      const imageData = cx.getImageData(0, 0, c.width, c.height);
      const dominant = extractDominantColor(imageData);

      applyAccent(dominant ? normalizeForAccent(dominant) : FALLBACK_RGB);
    } catch (err) {
      resetToFallback();
    }
  }

  function init() {
    if (!window.Musik?.events?.on) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    window.Musik.events.on('artupdate', handleArtUpdate);
  }

  init();
})();
