// src/ui/visualizer.js
// Renderer-side Now Playing visualizer. rAF loop runs only while
// `npf-open` is on <body>. 2D/3D both fall back to a synthetic idle
// animation when there's no analyser.
//
// 3D: noise-displaced icosahedron wireframe + solid core, bloom, optional
// FXAA, cursor-follow camera. THREE comes from three-loader.js (sets
// window.THREE). Postprocessing is hand-rolled against that global since
// the JSM addons need import(), which this app's CSP blocks.
//
// window.MusikVisualizer: { setMode, getMode, setSmoothing, getSmoothing,
// setQuality, getQuality }. window.MusikVisualizer3D: { isAvailable }.

(function () {
  const BAR_COUNT = 64;
  const INNER_RADIUS_RATIO = 0.58;
  const MAX_BAR_LENGTH_RATIO = 0.34;

  const SMOOTHING_STORAGE_KEY = 'musik:visualizer-smooth';
  const MODE_STORAGE_KEY = 'musik:visualizer-mode';
  const QUALITY_STORAGE_KEY = 'musik:visualizer-quality';

  // "Custom effects" — the mood-altering, might-hate-it bucket (Fresnel rim
  // lighting, dither), kept separate from the always-on quality tiers so it's
  // opt-in and A/B-able against a clean baseline. Master gates both subs;
  // each sub is independently toggleable once the master's on.
  const CUSTOM_FX_STORAGE_KEY = 'musik:visualizer-customfx';
  const FRESNEL_STORAGE_KEY = 'musik:visualizer-fresnel';
  const DITHER_STORAGE_KEY = 'musik:visualizer-dither';
  const DITHER_AMOUNT = 0.02;

  const LERP_CRISP = 0.65;
  const LERP_SMOOTH = 0.18;

  // low/med/high/ultra: pixel ratio cap + which passes run. fxaa dropped first on low-end GPUs.
  // msaaSamples: MSAA sample count (0 = off). geometryDetail: IcosahedronGeometry detail param
  // (vertex count ~= 10*detail^2+2). bloomResScale: fraction of canvas res the bloom blur chain
  // renders at (UnrealBloomPass halves whatever it's given, so we pre-double to hit this target).
  // ssaaScale: extra supersample multiplier stacked on top of pixelRatio — renders more physical
  // pixels than the canvas displays at; the browser's own canvas-to-screen downscale does the AA.
  const QUALITY_TIERS = {
    low:    { pixelRatio: 1,                                          msaaSamples: 2, fxaa: false, geometryDetail: 16, bloomResScale: 0.5,  bloomMips: 5, ssaaScale: 1,   preserveThinLines: false },
    medium: { pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), msaaSamples: 4, fxaa: false, geometryDetail: 18, bloomResScale: 0.5,  bloomMips: 5, ssaaScale: 1,   preserveThinLines: false },
    high:   { pixelRatio: Math.min(window.devicePixelRatio || 1, 2),   msaaSamples: 4, fxaa: true,  geometryDetail: 24, bloomResScale: 0.75, bloomMips: 6, ssaaScale: 1,   preserveThinLines: true },
    ultra:  { pixelRatio: Math.min(window.devicePixelRatio || 1, 2),   msaaSamples: 8, fxaa: true,  geometryDetail: 32, bloomResScale: 1.0,  bloomMips: 8, ssaaScale: 1.5, preserveThinLines: true },
  };

  const DEFAULT_ACCENT_RGB = '61, 184, 245';

  // Shared by 2D bar coloring + 3D shader zones. Hz -> bin fraction via real AnalyserNode sampleRate.
  const BAND_HZ = {
    bass:   [20, 250],
    mid:    [250, 2000],
    treble: [2000, 16000],
  };
  const BAND_KEYS = ['bass', 'mid', 'treble'];

  let smoothingOn = localStorage.getItem(SMOOTHING_STORAGE_KEY) !== 'off';
  let mode = localStorage.getItem(MODE_STORAGE_KEY) || '2d';
  let quality = localStorage.getItem(QUALITY_STORAGE_KEY) || 'medium';

  let customFxOn = localStorage.getItem(CUSTOM_FX_STORAGE_KEY) === 'on';
  let fresnelPref = localStorage.getItem(FRESNEL_STORAGE_KEY) !== 'off';
  let ditherPref = localStorage.getItem(DITHER_STORAGE_KEY) !== 'off';

  let running = false;
  let rafId = null;

  let controlsRoot = null;

  let accentRgbStr = DEFAULT_ACCENT_RGB;
  let bandRgbCache = { bass: DEFAULT_ACCENT_RGB, mid: DEFAULT_ACCENT_RGB, treble: DEFAULT_ACCENT_RGB };

  function refreshAccentCache() {
    accentRgbStr = getAccentRgb();
    const [ar, ag, ab] = accentRgbStr.split(',').map((n) => parseInt(n.trim(), 10) || 0);
    const [brr, brg, brb] = hueShiftRgb(ar, ag, ab, -25);
    const [trr, trg, trb] = hueShiftRgb(ar, ag, ab, 25);
    bandRgbCache = {
      bass: `${brr}, ${brg}, ${brb}`,
      mid: accentRgbStr,
      treble: `${trr}, ${trg}, ${trb}`,
    };
  }

  // ── 2D bar-ring mode ────────────────────────────────────────────────────

  let canvas = null;
  let ctx = null;
  let ro2d = null;
  let dataArray2d = null;
  let barValues = null;
  let barBandMap = null;
  let barBandMapKey = null;

  // bin -> Hz is `bin * nyquist / frequencyBinCount` (nyquist = sampleRate/2).
  // Cached by (frequencyBinCount, sampleRate) since neither changes often.
  function ensureBarBandMap(frequencyBinCount, sampleRate) {
    const key = frequencyBinCount + ':' + sampleRate;
    if (barBandMap && barBandMapKey === key) return barBandMap;
    barBandMapKey = key;
    barBandMap = new Uint8Array(BAR_COUNT);
    const usableBins = Math.floor(frequencyBinCount * 0.5);
    const step = usableBins / BAR_COUNT;
    const nyquist = sampleRate / 2;
    for (let i = 0; i < BAR_COUNT; i++) {
      const bin = Math.floor(i * step);
      const hz = (bin * nyquist) / frequencyBinCount;
      barBandMap[i] = hz < BAND_HZ.mid[0] ? 0 : (hz < BAND_HZ.treble[0] ? 1 : 2);
    }
    return barBandMap;
  }

  function ensureCanvas() {
    const mediaArea = document.getElementById('npf-media-area');
    if (!mediaArea) return null;
    if (canvas && canvas.isConnected) return canvas;

    canvas = document.createElement('canvas');
    canvas.id = 'npf-visualizer';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '0';
    canvas.style.pointerEvents = 'none';

    if (getComputedStyle(mediaArea).position === 'static') {
      mediaArea.style.position = 'relative';
    }
    mediaArea.insertBefore(canvas, mediaArea.firstChild);

    ctx = canvas.getContext('2d');
    resizeCanvas();

    if (window.ResizeObserver && !ro2d) {
      ro2d = new ResizeObserver(resizeCanvas);
      ro2d.observe(mediaArea);
    }
    return canvas;
  }

  function resizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function draw2d(analyser) {
    if (!analyser) return;
    if (!ensureCanvas()) return;

    if (!dataArray2d || dataArray2d.length !== analyser.frequencyBinCount) {
      dataArray2d = new Uint8Array(analyser.frequencyBinCount);
    }
    if (!barValues || barValues.length !== BAR_COUNT) {
      barValues = new Float32Array(BAR_COUNT);
    }
    analyser.getByteFrequencyData(dataArray2d);

    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const baseRadius = Math.min(w, h) / 2 * INNER_RADIUS_RATIO;
    const maxBarLen = Math.min(w, h) / 2 * MAX_BAR_LENGTH_RATIO;
    const lerpFactor = smoothingOn ? LERP_SMOOTH : LERP_CRISP;

    ctx.clearRect(0, 0, w, h);

    const usableBins = Math.floor(dataArray2d.length * 0.5);
    const step = usableBins / BAR_COUNT;
    const sampleRate = analyser.context.sampleRate;
    const bandMap = ensureBarBandMap(dataArray2d.length, sampleRate);

    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, (2 * Math.PI * baseRadius) / BAR_COUNT * 0.4);

    for (let i = 0; i < BAR_COUNT; i++) {
      const bin = Math.floor(i * step);
      const target = dataArray2d[bin] / 255;
      barValues[i] += (target - barValues[i]) * lerpFactor;
      const value = barValues[i];

      const barLen = value * maxBarLen;
      const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;

      const x1 = cx + Math.cos(angle) * baseRadius;
      const y1 = cy + Math.sin(angle) * baseRadius;
      const x2 = cx + Math.cos(angle) * (baseRadius + barLen);
      const y2 = cy + Math.sin(angle) * (baseRadius + barLen);

      const bandColor = bandRgbCache[BAND_KEYS[bandMap[i]]];
      ctx.strokeStyle = `rgba(${bandColor}, ${0.25 + value * 0.6})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // ── 3D blob mode ────────────────────────────────────────────────────────

  function getAccentRgb() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent-rgb').trim() || DEFAULT_ACCENT_RGB;
  }

  function bandEnergy(freqData, loFrac, hiFrac) {
    const len = freqData.length;
    const a = Math.floor(loFrac * len);
    const b = Math.max(a + 1, Math.floor(hiFrac * len));
    let sum = 0;
    for (let i = a; i < b; i++) sum += freqData[i];
    return sum / ((b - a) * 255);
  }

  function hzToFraction(hz, sampleRate) {
    return Math.max(0, Math.min(1, hz / (sampleRate / 2)));
  }

  function bandEnergyHz(freqData, sampleRate, loHz, hiHz) {
    return bandEnergy(freqData, hzToFraction(loHz, sampleRate), hzToFraction(hiHz, sampleRate));
  }

  function computeBands(freqData, sampleRate) {
    return {
      bass:   bandEnergyHz(freqData, sampleRate, BAND_HZ.bass[0], BAND_HZ.bass[1]),
      mid:    bandEnergyHz(freqData, sampleRate, BAND_HZ.mid[0], BAND_HZ.mid[1]),
      treble: bandEnergyHz(freqData, sampleRate, BAND_HZ.treble[0], Math.min(BAND_HZ.treble[1], sampleRate / 2)),
    };
  }

  function hueShiftRgb(r, g, b, degrees, lightDelta) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    let l = (max + min) / 2;
    const s = d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min));
    if (lightDelta) l = Math.max(0.08, Math.min(0.92, l + lightDelta));

    if (d !== 0) {
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
    }
    h = (h + degrees + 360) % 360;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r2 = 0, g2 = 0, b2 = 0;
    if      (h < 60)  { r2 = c; g2 = x; b2 = 0; }
    else if (h < 120) { r2 = x; g2 = c; b2 = 0; }
    else if (h < 180) { r2 = 0; g2 = c; b2 = x; }
    else if (h < 240) { r2 = 0; g2 = x; b2 = c; }
    else if (h < 300) { r2 = x; g2 = 0; b2 = c; }
    else              { r2 = c; g2 = 0; b2 = x; }

    return [
      Math.round((r2 + m) * 255),
      Math.round((g2 + m) * 255),
      Math.round((b2 + m) * 255),
    ];
  }

  function getAccentRgbArray() {
    const raw = getAccentRgb();
    const matches = raw.match(/\d+/g);
    if (matches && matches.length >= 3) {
      return [parseInt(matches[0], 10), parseInt(matches[1], 10), parseInt(matches[2], 10)];
    }
    return [61, 184, 245];
  }

  function accentColorThree(THREE) {
    const [ar, ag, ab] = getAccentRgbArray();
    return new THREE.Color(ar / 255, ag / 255, ab / 255);
  }

  // DitherShader is Musik's own. Everything else the 3D blob's
  // post-processing needs (EffectComposer/RenderPass/UnrealBloomPass/
  // FXAAShader) comes from three-postfx.js, loaded via loadThree() below.
  const DitherShader = {
      uniforms: { 'tDiffuse': { value: null }, 'amount': { value: 0.0 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float amount;
          varying vec2 vUv;
          float bayerDither(vec2 fragCoord) {
              float bayer[16];
              bayer[0]=0.0;  bayer[1]=8.0;  bayer[2]=2.0;  bayer[3]=10.0;
              bayer[4]=12.0; bayer[5]=4.0;  bayer[6]=14.0; bayer[7]=6.0;
              bayer[8]=3.0;  bayer[9]=11.0; bayer[10]=1.0; bayer[11]=9.0;
              bayer[12]=15.0;bayer[13]=7.0; bayer[14]=13.0;bayer[15]=5.0;
              int x = int(mod(fragCoord.x, 4.0));
              int y = int(mod(fragCoord.y, 4.0));
              int idx = y * 4 + x;
              for (int i = 0; i < 16; i++) { if (i == idx) return bayer[i] / 16.0; }
              return 0.0;
          }
          void main() {
              vec4 texel = texture2D(tDiffuse, vUv);
              float d = (bayerDither(gl_FragCoord.xy) - 0.5) * amount;
              gl_FragColor = vec4(texel.rgb + vec3(d), texel.a);
          }
      `
  };

  let threeLoadFailed = false;

  // Wraps three-postfx.js's loader, adding DitherShader to the result.
  function loadThree() {
    return window.MusikThreePostFX.load()
      .then((mod) => Object.assign({}, mod, { DitherShader }))
      .catch((err) => { threeLoadFailed = true; throw err; });
  }

  // Classic 3D Perlin noise (Ashima Arts / Stefan Gustavson-style —
  // standard utility used throughout three.js shader demos). Displaces
  // blob vertices along their normals.
  const NOISE_GLSL = `
    vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

    float pnoise(vec3 P) {
      vec3 Pi0 = floor(P);
      vec3 Pi1 = Pi0 + vec3(1.0);
      Pi0 = mod(Pi0, 289.0);
      Pi1 = mod(Pi1, 289.0);
      vec3 Pf0 = fract(P);
      vec3 Pf1 = Pf0 - vec3(1.0);
      vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
      vec4 iy = vec4(Pi0.y, Pi0.y, Pi1.y, Pi1.y);
      vec4 iz0 = vec4(Pi0.z);
      vec4 iz1 = vec4(Pi1.z);

      vec4 ixy = permute(permute(ix) + iy);
      vec4 ixy0 = permute(ixy + iz0);
      vec4 ixy1 = permute(ixy + iz1);

      vec4 gx0 = ixy0 / 7.0;
      vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
      gx0 = fract(gx0);
      vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
      vec4 sz0 = step(gz0, vec4(0.0));
      gx0 -= sz0 * (step(0.0, gx0) - 0.5);
      gy0 -= sz0 * (step(0.0, gy0) - 0.5);

      vec4 gx1 = ixy1 / 7.0;
      vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
      gx1 = fract(gx1);
      vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
      vec4 sz1 = step(gz1, vec4(0.0));
      gx1 -= sz1 * (step(0.0, gx1) - 0.5);
      gy1 -= sz1 * (step(0.0, gy1) - 0.5);

      vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
      vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
      vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
      vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
      vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
      vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
      vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
      vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);

      vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
      g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
      vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
      g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;

      float n000 = dot(g000, Pf0);
      float n100 = dot(g100, vec3(Pf1.x, Pf0.y, Pf0.z));
      float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
      float n110 = dot(g110, vec3(Pf1.x, Pf1.y, Pf0.z));
      float n001 = dot(g001, vec3(Pf0.x, Pf0.y, Pf1.z));
      float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
      float n011 = dot(g011, vec3(Pf0.x, Pf1.y, Pf1.z));
      float n111 = dot(g111, Pf1);

      vec3 fadeXYZ = fade(Pf0);
      vec4 nz = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fadeXYZ.z);
      vec2 nxy = mix(nz.xy, nz.zw, fadeXYZ.y);
      float nxyz = mix(nxy.x, nxy.y, fadeXYZ.x);
      return 2.2 * nxyz;
    }
  `;

  const BLOB_VERTEX = `
    uniform float uTime;
    uniform float uAmpBass;
    uniform float uAmpMid;
    uniform float uAmpTreble;
    uniform float uFreq;
    varying float vDisplacement;
    varying vec3 vNormalView;
    varying vec3 vViewDir;
    ${NOISE_GLSL}

    void main() {
      // Vertical bands: treble on top, bass on bottom, mid in the middle.
      // A small static noise wobble on the boundary keeps the seam from
      // looking like a hard sticker edge, but the zones stay legible —
      // this is what makes different parts of the blob move for different
      // bands. Purely a displacement-amplitude blend now, no color tied
      // to it — the color-coded zones read as a flag, not audio.
      vec3 zonePos = normalize(position);
      float wobble = pnoise(zonePos * 2.0 + vec3(12.3, 4.5, 8.1)) * 0.15;
      float y = zonePos.y + wobble;

      float bassWeight   = 1.0 - smoothstep(-0.55, -0.15, y);
      float trebleWeight = smoothstep(0.15, 0.55, y);
      float midWeight    = clamp(1.0 - bassWeight - trebleWeight, 0.0, 1.0);

      float zoneSum = bassWeight + midWeight + trebleWeight;
      vec3 zoneWeights = vec3(bassWeight, midWeight, trebleWeight) / max(zoneSum, 0.0001);

      float amp = uAmpBass * zoneWeights.x + uAmpMid * zoneWeights.y + uAmpTreble * zoneWeights.z;
      vec3 noisePos = position * uFreq + vec3(uTime * 0.25);
      float displacement = pnoise(noisePos) * amp;
      vDisplacement = displacement;
      vec3 newPosition = position + normal * displacement;

      vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
      vNormalView = normalize(normalMatrix * normal);
      vViewDir = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const BLOB_FRAGMENT = `
    uniform vec3 uColor;
    varying float vDisplacement;

    void main() {
      float shimmer = 0.85 + 0.3 * clamp(vDisplacement * 0.5 + 0.5, 0.0, 1.0);
      gl_FragColor = vec4(uColor * shimmer, 1.0);
    }
  `;

  // Core mesh sits just inside the wireframe (see coreMesh.scale below) and was
  // flat black before — this lights up its silhouette edge with the accent
  // color, "energy shield" style. uFresnelEnabled is a 0/1 uniform rather than
  // a shader recompile so toggling the setting is instant and never forces a
  // scene rebuild. Fully off (0.0) reproduces the exact old flat-black output.
  const CORE_FRAGMENT = `
    uniform vec3 uColor;
    uniform float uFresnelEnabled;
    uniform float uFresnelPower;
    uniform float uFresnelIntensity;
    varying vec3 vNormalView;
    varying vec3 vViewDir;

    void main() {
      float facing = clamp(dot(normalize(vNormalView), normalize(vViewDir)), 0.0, 1.0);
      float fresnel = pow(1.0 - facing, uFresnelPower);
      vec3 rim = uColor * fresnel * uFresnelIntensity * uFresnelEnabled;
      gl_FragColor = vec4(rim, 1.0);
    }
  `;


  let blobRenderer  = null;
  let blobComposer  = null;
  let blobScene     = null;
  let blobCamera    = null;
  let blobMesh      = null;
  let coreMesh      = null;
  let blobMaterial  = null;
  let fxaaPass      = null;
  let ditherPass    = null;
  let blobCanvasEl  = null;
  let blobResize    = null;
  let blobMouseMove = null;
  let blobClock     = null;
  let blobSceneLoading = false;

  let blobTargetX = 0, blobTargetY = 0;
  let blobMouseActive = false;
  let blobMouseTimer = null;

  function makeBlobCanvas(mount) {
    const el = document.createElement('canvas');
    el.id = 'npf-visualizer-3d';
    el.style.display = 'block';
    el.style.margin = '0 auto';
    el.style.width = '100%';
    el.style.aspectRatio = '1 / 1';
    el.style.maxWidth = '65vh';
    el.style.maxHeight = '65vh';
    el.style.border = '2px solid rgba(255, 255, 255, 0.15)';
    el.style.borderRadius = '12px';
    el.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.6)';
    mount.insertBefore(el, mount.firstChild);
    return el;
  }

  async function ensureScene3d(mount) {
    if (blobRenderer || blobSceneLoading || threeLoadFailed) return;
    blobSceneLoading = true;

    let mod;
    try {
      mod = await loadThree();
    } catch (err) {
      console.error('[Musik] visualizer: failed to load Three.js, falling back to 2D.', err);
      blobSceneLoading = false;
      setMode('2d');
      return;
    }
    blobSceneLoading = false;
    if (mode !== '3d') return;

    const { THREE, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, FXAAShader, DitherShader } = mod;
    const tier = QUALITY_TIERS[quality] || QUALITY_TIERS.medium;

    const canvas = makeBlobCanvas(mount);
    blobCanvasEl = canvas;

    const W = canvas.clientWidth || mount.clientWidth || window.innerWidth;
    const H = canvas.clientHeight || mount.clientHeight || window.innerHeight;

    blobScene = new THREE.Scene();
    blobCamera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
    blobCamera.position.z = 7.5;

    blobRenderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
    blobRenderer.setClearColor(0x000000, 0);
    // SSAA: render at pixelRatio * ssaaScale physical pixels; canvas CSS size stays put,
    // so the browser's own downscale-on-paint does the supersample averaging. Ultra-only.
    const pr = tier.pixelRatio * (tier.ssaaScale || 1);
    blobRenderer.setPixelRatio(pr);
    blobRenderer.setSize(W, H, false);

    const geometry = new THREE.IcosahedronGeometry(1.8, tier.geometryDetail);
    const accentColor = accentColorThree(THREE);

    blobMaterial = new THREE.ShaderMaterial({
      vertexShader: BLOB_VERTEX,
      fragmentShader: BLOB_FRAGMENT,
      wireframe: true,
      uniforms: {
        uTime:      { value: 0 },
        uAmpBass:   { value: 0.15 },
        uAmpMid:    { value: 0.15 },
        uAmpTreble: { value: 0.15 },
        uFreq:      { value: 1.4 },
        uColor:     { value: accentColor },
        uFresnelEnabled:   { value: (customFxOn && fresnelPref) ? 1.0 : 0.0 },
        uFresnelPower:     { value: 6.0 },
        uFresnelIntensity: { value: 0.2 },
      },
    });

    blobMesh = new THREE.Mesh(geometry, blobMaterial);
    blobScene.add(blobMesh);

    const coreMaterial = new THREE.ShaderMaterial({
      vertexShader: BLOB_VERTEX,
      fragmentShader: CORE_FRAGMENT,
      uniforms: blobMaterial.uniforms,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    coreMesh = new THREE.Mesh(geometry, coreMaterial);
    coreMesh.scale.set(0.97, 0.97, 0.97);
    blobScene.add(coreMesh);

    blobComposer = new EffectComposer(blobRenderer, undefined, tier.msaaSamples);
    blobComposer.addPass(new RenderPass(blobScene, blobCamera));

    // UnrealBloomPass halves whatever resolution it's given for its blur chain, so pre-double
    // to land the internal bloom res at tier.bloomResScale * canvas size.
    const bloomRes = new THREE.Vector2(W * tier.bloomResScale * 2, H * tier.bloomResScale * 2);
    const bloomPass = new UnrealBloomPass(bloomRes, 0.85, 0.25, 0.22, tier.bloomMips, tier.preserveThinLines);
    blobComposer.addPass(bloomPass);

    if (tier.fxaa) {
      fxaaPass = new ShaderPass(FXAAShader);
      fxaaPass.uniforms['resolution'].value.set(1 / (W * pr), 1 / (H * pr));
      blobComposer.addPass(fxaaPass);
    } else {
      fxaaPass = null;
    }

    // Always added (cheap single-tap-per-pixel pass), gated live via the
    // `amount` uniform so the Custom effects toggle doesn't need to rebuild
    // the composer chain. amount = 0.0 reproduces the exact pre-dither frame.
    ditherPass = new ShaderPass(DitherShader);
    ditherPass.uniforms['amount'].value = (customFxOn && ditherPref) ? DITHER_AMOUNT : 0.0;
    blobComposer.addPass(ditherPass);

    blobMouseMove = (e) => {
      blobMouseActive = true;
      clearTimeout(blobMouseTimer);
      blobMouseTimer = setTimeout(() => { blobMouseActive = false; }, 2500);
      blobTargetX = (e.clientX / window.innerWidth - 0.5) * 1.2;
      blobTargetY = (e.clientY / window.innerHeight - 0.5) * 1.2;
    };
    window.addEventListener('mousemove', blobMouseMove);

    blobResize = () => {
      if (blobCanvasEl !== canvas || !blobRenderer) return;
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      blobCamera.aspect = w / h;
      blobCamera.updateProjectionMatrix();
      blobRenderer.setSize(w, h, false);
      blobComposer.setSize(w, h);
      if (fxaaPass) {
        fxaaPass.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
      }
    };
    window.addEventListener('resize', blobResize);

    blobClock = new THREE.Timer();
  }

  function draw3d(analyser, mount) {
    if (!blobRenderer) {
      if (!blobSceneLoading) ensureScene3d(mount);
      return;
    }

    let bass, mid, treble;
    if (analyser) {
      if (!draw3d._freqData || draw3d._freqData.length !== analyser.frequencyBinCount) {
        draw3d._freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(draw3d._freqData);
      const bands = computeBands(draw3d._freqData, analyser.context.sampleRate);
      bass = bands.bass; mid = bands.mid; treble = bands.treble;
    } else {
      const t = performance.now() / 1000;
      bass   = 0.16 + Math.sin(t * 0.15) * 0.05;
      mid    = 0.14 + Math.sin(t * 0.13 + 0.9) * 0.05;
      treble = 0.12 + Math.sin(t * 0.11 + 1.7) * 0.04;
    }

    const smoothBand = (key, target) => {
      const prev = draw3d[key] || 0;
      draw3d[key] = target > prev ? prev * 0.4 + target * 0.6 : prev * 0.88 + target * 0.12;
      return draw3d[key];
    };
    const smoothedBass   = smoothBand('_smoothedBass', bass);
    const smoothedMid    = smoothBand('_smoothedMid', mid);
    const smoothedTreble = smoothBand('_smoothedTreble', treble);

    const [ar, ag, ab] = getAccentRgbArray();
    blobMaterial.uniforms.uColor.value.setRGB(ar / 255, ag / 255, ab / 255);

    const sensitivity = parseFloat(localStorage.getItem('musik_vis_sensitivity') || '1.0');
    blobClock.update();
    const delta = Math.min(blobClock.getDelta(), 0.1);
    const time = blobClock.getElapsed();

    blobMaterial.uniforms.uTime.value = time;
    // Power curve (not linear) so quiet bands settle near-still instead of
    // idling at a shared floor, and loud bands pop clearly above it — this
    // is what makes "that part is moving because of the kick" readable.
    const ampCurve = (v) => Math.pow(Math.max(0, v), 1.6);
    blobMaterial.uniforms.uAmpBass.value   = (0.015 + ampCurve(smoothedBass) * 0.22) * sensitivity;
    blobMaterial.uniforms.uAmpMid.value    = (0.015 + ampCurve(smoothedMid) * 0.22) * sensitivity;
    blobMaterial.uniforms.uAmpTreble.value = (0.015 + ampCurve(smoothedTreble) * 0.22) * sensitivity;
    blobMaterial.uniforms.uFreq.value = 1.2 + smoothedTreble * 1.5;

    blobMesh.rotation.y += (0.09 + smoothedBass * 0.6) * delta;
    coreMesh.rotation.y = blobMesh.rotation.y;

    if (!blobMouseActive) {
      blobTargetX = Math.sin(time * 0.15) * 0.4;
      blobTargetY = Math.cos(time * 0.1) * 0.2;
    }

    blobCamera.position.x += (blobTargetX - blobCamera.position.x) * 0.04;
    blobCamera.position.y += (-blobTargetY - blobCamera.position.y) * 0.04;
    blobCamera.lookAt(blobScene.position);

    blobComposer.render();
  }

  function teardown3d() {
    if (blobMouseMove) { window.removeEventListener('mousemove', blobMouseMove); blobMouseMove = null; }
    if (blobResize)    { window.removeEventListener('resize', blobResize);       blobResize = null; }
    clearTimeout(blobMouseTimer);
    blobMouseActive = false;

    if (blobMesh) {
      blobMesh.geometry?.dispose();
      blobMesh.material?.dispose();
      blobScene?.remove(blobMesh);
      blobMesh = null;
    }
    if (coreMesh) {
      coreMesh.material?.dispose();
      blobScene?.remove(coreMesh);
      coreMesh = null;
    }
    if (fxaaPass) { fxaaPass.dispose(); fxaaPass = null; }
    if (ditherPass) { ditherPass.dispose(); ditherPass = null; }

    blobComposer = null;
    blobScene = null;
    blobCamera = null;
    blobMaterial = null;
    blobClock = null;

    if (blobRenderer) {
      try {
        blobRenderer.dispose();
        blobRenderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch (_) {}
      blobRenderer = null;
    }
    if (blobCanvasEl) { blobCanvasEl.remove(); blobCanvasEl = null; }
    blobSceneLoading = false;
  }

  // ── Controls, lifecycle, public API ────────────────────────────────────

  function kick(el, className) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    el.addEventListener('animationend', () => el.classList.remove(className), { once: true });
  }

  function ensureControls() {
    const topbar = document.querySelector('.npf-topbar');
    if (!topbar || controlsRoot) return;

    controlsRoot = document.createElement('div');
    controlsRoot.id = 'npf-vis-controls';
    controlsRoot.style.display = 'flex';
    controlsRoot.style.alignItems = 'center';
    controlsRoot.style.gap = '8px';
    controlsRoot.style.marginRight = '4px';

    controlsRoot.innerHTML = `
      <button id="npf-vis-smooth-toggle" class="npf-topbar-btn" title="Toggle visualizer smoothing"
        style="width:auto; padding:0 10px; font-size:10px; font-family:var(--font-mono); letter-spacing:0.04em; border-radius:999px; background:rgba(255,255,255,0.06);">
        SMOOTH
      </button>
      <div id="npf-vis-mode-switch" title="Switch visualizer mode"
        style="position:relative; display:flex; width:64px; height:26px; border-radius:999px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); cursor:pointer; overflow:hidden;">
        <div id="npf-vis-mode-thumb" style="position:absolute; top:2px; left:2px; width:30px; height:20px; border-radius:999px; background:var(--color-accent); transition:transform 260ms var(--ease-spring, cubic-bezier(0.34,1.56,0.64,1)), background 200ms ease; z-index:1;"></div>
        <span data-mode="2d" style="flex:1; z-index:2; display:flex; align-items:center; justify-content:center; font-size:9px; font-family:var(--font-mono); font-weight:700; color:#000; transition:color 200ms ease;">2D</span>
        <span data-mode="3d" style="flex:1; z-index:2; display:flex; align-items:center; justify-content:center; font-size:9px; font-family:var(--font-mono); font-weight:700; color:rgba(255,255,255,0.5); transition:color 200ms ease;">3D</span>
      </div>
    `;

    topbar.insertBefore(controlsRoot, topbar.querySelector('#npf-lyrics-toggle'));
    applyModeStyles();

    controlsRoot.querySelector('#npf-vis-smooth-toggle').addEventListener('click', (e) => {
      kick(e.currentTarget, 'npf-vis-kick');
      setSmoothing(!smoothingOn);
    });
    controlsRoot.querySelector('#npf-vis-mode-switch').addEventListener('click', () => {
      kick(controlsRoot.querySelector('#npf-vis-mode-thumb'), 'npf-vis-thumb-kick');
      setMode(mode === '2d' ? '3d' : '2d');
    });

    updateControlsUI();
  }

  function updateControlsUI() {
    if (!controlsRoot) return;
    const smoothBtn = controlsRoot.querySelector('#npf-vis-smooth-toggle');
    smoothBtn.style.color = smoothingOn ? 'var(--color-accent)' : 'rgba(255,255,255,0.45)';
    smoothBtn.style.background = smoothingOn ? 'rgba(var(--color-accent-rgb), 0.14)' : 'rgba(255,255,255,0.06)';

    const thumb = controlsRoot.querySelector('#npf-vis-mode-thumb');
    const label2d = controlsRoot.querySelector('[data-mode="2d"]');
    const label3d = controlsRoot.querySelector('[data-mode="3d"]');
    if (mode === '3d') {
      thumb.style.transform = 'translateX(32px)';
      label3d.style.color = '#000';
      label2d.style.color = 'rgba(255,255,255,0.5)';
    } else {
      thumb.style.transform = 'translateX(0)';
      label2d.style.color = '#000';
      label3d.style.color = 'rgba(255,255,255,0.5)';
    }
  }

  function setSmoothing(on) {
    smoothingOn = !!on;
    localStorage.setItem(SMOOTHING_STORAGE_KEY, smoothingOn ? 'on' : 'off');
    updateControlsUI();
  }

  function applyModeStyles() {
    if (canvas) canvas.style.display = mode === '2d' ? '' : 'none';
    if (blobCanvasEl) blobCanvasEl.style.display = mode === '3d' ? '' : 'none';

    const artWrap = document.getElementById('npf-art-wrap');
    if (artWrap) artWrap.style.display = mode === '3d' ? 'none' : '';
  }

  function setQuality(next) {
    if (!QUALITY_TIERS[next]) return;
    quality = next;
    localStorage.setItem(QUALITY_STORAGE_KEY, quality);
    if (blobRenderer) teardown3d();
  }

  // Fresnel and dither are both uniform-gated (see BLOB_VERTEX/CORE_FRAGMENT/
  // DitherShader) rather than baked into the shader source, so flipping any
  // of these three applies live to an already-running scene — no teardown,
  // no rebuild, no flicker.
  function applyCustomFxUniforms() {
    const fresnelActive = customFxOn && fresnelPref;
    const ditherActive = customFxOn && ditherPref;
    if (blobMaterial) blobMaterial.uniforms.uFresnelEnabled.value = fresnelActive ? 1.0 : 0.0;
    if (ditherPass) ditherPass.uniforms['amount'].value = ditherActive ? DITHER_AMOUNT : 0.0;
  }

  function setCustomFx(on) {
    customFxOn = !!on;
    localStorage.setItem(CUSTOM_FX_STORAGE_KEY, customFxOn ? 'on' : 'off');
    applyCustomFxUniforms();
  }

  function setFresnel(on) {
    fresnelPref = !!on;
    localStorage.setItem(FRESNEL_STORAGE_KEY, fresnelPref ? 'on' : 'off');
    applyCustomFxUniforms();
  }

  function setDither(on) {
    ditherPref = !!on;
    localStorage.setItem(DITHER_STORAGE_KEY, ditherPref ? 'on' : 'off');
    applyCustomFxUniforms();
  }

  function setMode(next) {
    if (next !== '2d' && next !== '3d') return;
    mode = next;
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    updateControlsUI();
    applyModeStyles();
    if (mode === '2d' && blobRenderer) teardown3d();
  }

  function frame() {
    if (!running) return;

    const isOpen = document.body.classList.contains('npf-open');
    if (isOpen) {
      ensureControls();
      const analyser = window.MusikPlayerUI?.getAnalyser?.();
      if (mode === '3d') {
        const mount = document.getElementById('npf-media-area');
        if (mount) {
          if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';
          draw3d(analyser, mount);
        }
      } else {
        draw2d(analyser);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (blobRenderer) teardown3d();
  }

  function initLifecycle() {
    const bodyObserver = new MutationObserver(() => {
      if (document.body.classList.contains('npf-open')) startLoop();
      else stopLoop();
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    if (document.body.classList.contains('npf-open')) startLoop();

    refreshAccentCache();
    window.Musik?.events?.on('accentupdate', refreshAccentCache);

    window.addEventListener('musik:visualizer-settings-change', (e) => {
      if (e.detail?.quality) setQuality(e.detail.quality);
      if (typeof e.detail?.customFx === 'boolean') setCustomFx(e.detail.customFx);
      if (typeof e.detail?.fresnel === 'boolean') setFresnel(e.detail.fresnel);
      if (typeof e.detail?.dither === 'boolean') setDither(e.detail.dither);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLifecycle, { once: true });
  } else {
    initLifecycle();
  }

  window.MusikVisualizer = {
    setMode,
    getMode: () => mode,
    setSmoothing,
    getSmoothing: () => smoothingOn,
    setQuality,
    getQuality: () => quality,
    setCustomFx,
    getCustomFx: () => customFxOn,
    setFresnel,
    getFresnel: () => fresnelPref,
    setDither,
    getDither: () => ditherPref,
  };

  window.MusikVisualizer3D = { isAvailable: () => !threeLoadFailed };
})();
