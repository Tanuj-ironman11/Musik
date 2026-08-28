// src/ui/visualizer.js
// Renderer-side Now Playing visualizer.
//
// Single rAF loop, only scheduled while `npf-open` is on <body> (see
// MutationObserver in initLifecycle). 2D mode falls back to a synthetic
// idle animation when there's no analyser; 3D mode does the same (gentle
// sine-driven bass/treble) so the blob keeps breathing when nothing's
// playing instead of freezing.
//
// 3D mode: the ORIGINAL blob engine, ported back in from the pre-rewrite
// fullscreen.js (noise-displaced icosahedron wireframe + solid core mesh,
// UnrealBloomPass glow, optional FXAA, temporal accumulation pass,
// cursor-follow camera). Three.js itself is NOT loaded by this file —
// index.html already loads node_modules/three/build/three.min.js as a
// plain global <script> before visualizer.js, so window.THREE is present
// by the time this runs. A hand-rolled EffectComposer/Pass/UnrealBloomPass/
// FXAA/TemporalPass bundle (the postprocessing addons, which only ship as
// JSM and can't be `import()`-ed under this app's CSP) is built against
// that global THREE the first time 3D mode is used, then reused.
//
// window.MusikVisualizer exposes { setMode, getMode, setSmoothing,
// getSmoothing, setQuality, getQuality }.
// window.MusikVisualizer3D exposes { isAvailable } (legacy surface —
// "available" is optimistic here since we can't know until the script
// load resolves; setMode('3d') silently falls back to 2D if it fails).

(function () {
  const BAR_COUNT = 64;
  const INNER_RADIUS_RATIO = 0.58;
  const MAX_BAR_LENGTH_RATIO = 0.34;

  const SMOOTHING_STORAGE_KEY = 'musik:visualizer-smooth';
  const MODE_STORAGE_KEY = 'musik:visualizer-mode';
  const QUALITY_STORAGE_KEY = 'musik:visualizer-quality';

  const LERP_CRISP = 0.65;
  const LERP_SMOOTH = 0.18;

  // low/medium/high map to pixel ratio cap + which postprocessing passes
  // run. FXAA/temporal-accumulation are extra composer passes on top of
  // bloom, so they're the first things dropped on low-end GPUs.
  const QUALITY_TIERS = {
    low:    { pixelRatio: 1,                                          fxaa: false, temporal: false },
    medium: { pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), fxaa: false, temporal: true },
    high:   { pixelRatio: Math.min(window.devicePixelRatio || 1, 2),   fxaa: true,  temporal: true },
  };

  const DEFAULT_ACCENT_RGB = '61, 184, 245';

  let smoothingOn = localStorage.getItem(SMOOTHING_STORAGE_KEY) !== 'off';
  let mode = localStorage.getItem(MODE_STORAGE_KEY) || '2d';
  let quality = localStorage.getItem(QUALITY_STORAGE_KEY) || 'medium';

  let running = false;
  let rafId = null;

  let controlsRoot = null;

  let accentRgbStr = DEFAULT_ACCENT_RGB;

  function refreshAccentCache() {
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--color-accent-rgb').trim();
    accentRgbStr = rgb || DEFAULT_ACCENT_RGB;
  }

  // ── 2D bar-ring mode ────────────────────────────────────────────────────

  let canvas = null;
  let ctx = null;
  let ro2d = null;
  let dataArray2d = null;
  let barValues = null;

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

      ctx.strokeStyle = `rgba(${accentRgbStr}, ${0.25 + value * 0.6})`;
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

  function hueShiftRgb(r, g, b, degrees) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min));

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

  function accentColorsToVec3(THREE) {
    const [ar, ag, ab] = getAccentRgbArray();
    const [br, bg, bb] = hueShiftRgb(ar, ag, ab, 20);
    return [
      new THREE.Color(ar / 255, ag / 255, ab / 255),
      new THREE.Color(br / 255, bg / 255, bb / 255),
    ];
  }

  let threeModulePromise = null;
  let threeLoadFailed = false;

  // Waits for window.THREE to exist. In practice this resolves on the
  // very first check: index.html loads node_modules/three/build/three.min.js
  // as a plain deferred <script> BEFORE visualizer.js's own <script> tag,
  // and deferred scripts execute strictly in document order — so THREE is
  // already attached to window by the time this file's top-level code
  // runs. The poll loop below is just a defensive fallback in case that
  // load order ever changes; it is not the expected path.
  function waitForGlobalThree(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (window.THREE) { resolve(window.THREE); return; }
      const start = performance.now();
      const poll = setInterval(() => {
        if (window.THREE) {
          clearInterval(poll);
          resolve(window.THREE);
        } else if (performance.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error('window.THREE never appeared — check that node_modules/three/build/three.min.js is loading before visualizer.js in index.html'));
        }
      }, 50);
    });
  }

  // Hand-implements the postprocessing pass classes (Pass/EffectComposer/
  // RenderPass/ShaderPass/UnrealBloomPass/FXAAShader/TemporalPass) against
  // the already-loaded global window.THREE. This is the exact bundle from
  // the original implementation — kept as-is rather than swapped for real
  // JSM addon imports, since those require `import()` of ES modules and
  // three.min.js here is the classic global (non-module) build.
  function loadThree() {
    if (!threeModulePromise) {
      threeModulePromise = waitForGlobalThree()
        .then((THREE) => {
          if (!THREE) throw new Error('window.THREE not set');

          class Pass {
              constructor() {
                  this.isPass = true; this.enabled = true; this.needsSwap = true;
                  this.clear = false; this.renderToScreen = false;
              }
              setSize( width, height ) {}
              render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {
                  console.error( 'THREE.Pass: .render() must be implemented in derived pass.' );
              }
          }

          class FullScreenQuad {
              constructor( material ) {
                  if ( !FullScreenQuad.geometry ) {
                      FullScreenQuad.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
                      FullScreenQuad.geometry = new THREE.BufferGeometry();
                      FullScreenQuad.geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ - 1, - 1, 0, 3, - 1, 0, - 1, 3, 0 ], 3 ) );
                      FullScreenQuad.geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( [ 0, 0, 2, 0, 0, 2 ], 2 ) );
                  }
                  this._mesh = new THREE.Mesh( FullScreenQuad.geometry, material );
                  this._mesh.frustumCulled = false;
              }
              dispose() { this._mesh.geometry.dispose(); }
              render( renderer ) { renderer.render( this._mesh, FullScreenQuad.camera ); }
              get material() { return this._mesh.material; }
              set material( value ) { this._mesh.material = value; }
          }

          const CopyShader = {
              uniforms: { 'tDiffuse': { value: null }, 'opacity': { value: 1.0 } },
              vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
              fragmentShader: `uniform float opacity; uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 texel = texture2D( tDiffuse, vUv ); gl_FragColor = opacity * texel; }`
          };

          class ShaderPass extends Pass {
              constructor( shader, textureID ) {
                  super();
                  this.textureID = ( textureID !== undefined ) ? textureID : 'tDiffuse';
                  this.uniforms = THREE.UniformsUtils.clone( shader.uniforms );
                  this.material = new THREE.ShaderMaterial( {
                      defines: Object.assign( {}, shader.defines ),
                      uniforms: this.uniforms, vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader
                  } );
                  this.fsQuad = new FullScreenQuad( this.material );
              }
              render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {
                  if ( this.uniforms[ this.textureID ] ) this.uniforms[ this.textureID ].value = readBuffer.texture;
                  this.fsQuad.material = this.material;
                  if ( this.renderToScreen ) {
                      renderer.setRenderTarget( null ); this.fsQuad.render( renderer );
                  } else {
                      renderer.setRenderTarget( writeBuffer );
                      if ( this.clear ) renderer.clear( renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil );
                      this.fsQuad.render( renderer );
                  }
              }
              dispose() { this.material.dispose(); this.fsQuad.dispose(); }
          }

          class EffectComposer {
              constructor( renderer, renderTarget ) {
                  this.renderer = renderer;
                  if ( renderTarget === undefined ) {
                      const size = renderer.getSize( new THREE.Vector2() );
                      this._pixelRatio = renderer.getPixelRatio();
                      this._width = size.width; this._height = size.height;

                      renderTarget = new THREE.WebGLRenderTarget( this._width * this._pixelRatio, this._height * this._pixelRatio );
                      const aaType = localStorage.getItem('musik_aa_type') || 'msaa';
                      if (aaType === 'msaa' && renderer.capabilities.isWebGL2) {
                          renderTarget.samples = 4;
                      }
                  }
                  this.renderTarget1 = renderTarget; this.renderTarget2 = renderTarget.clone();
                  this.writeBuffer = this.renderTarget1; this.readBuffer = this.renderTarget2;
                  this.renderToScreen = true; this.passes = [];
                  this.copyPass = new ShaderPass( CopyShader ); this.clock = new THREE.Clock();
              }
              swapBuffers() {
                  const tmp = this.readBuffer; this.readBuffer = this.writeBuffer; this.writeBuffer = tmp;
              }
              addPass( pass ) {
                  this.passes.push( pass );
                  pass.setSize( this._width * this._pixelRatio, this._height * this._pixelRatio );
              }
              isLastEnabledPass( passIndex ) {
                  for ( let i = passIndex + 1; i < this.passes.length; i ++ ) { if ( this.passes[ i ].enabled ) return false; }
                  return true;
              }
              render( deltaTime ) {
                  if ( deltaTime === undefined ) deltaTime = this.clock.getDelta();
                  const currentRenderTarget = this.renderer.getRenderTarget();
                  for ( let i = 0, il = this.passes.length; i < il; i ++ ) {
                      const pass = this.passes[ i ];
                      if ( pass.enabled === false ) continue;
                      pass.renderToScreen = ( this.renderToScreen && this.isLastEnabledPass( i ) );
                      pass.render( this.renderer, this.writeBuffer, this.readBuffer, deltaTime, false );
                      if ( pass.needsSwap ) this.swapBuffers();
                  }
                  this.renderer.setRenderTarget( currentRenderTarget );
              }
              setSize( width, height ) {
                  this._width = width; this._height = height;
                  const effectiveWidth = this._width * this._pixelRatio;
                  const effectiveHeight = this._height * this._pixelRatio;
                  this.renderTarget1.setSize( effectiveWidth, effectiveHeight );
                  this.renderTarget2.setSize( effectiveWidth, effectiveHeight );
                  for ( let i = 0; i < this.passes.length; i ++ ) this.passes[ i ].setSize( effectiveWidth, effectiveHeight );
              }
          }

          class RenderPass extends Pass {
              constructor( scene, camera, overrideMaterial, clearColor, clearAlpha ) {
                  super();
                  this.scene = scene; this.camera = camera; this.overrideMaterial = overrideMaterial;
                  this.clearColor = clearColor; this.clearAlpha = clearAlpha;
                  this.clear = true; this.clearDepth = false; this.needsSwap = false;
              }
              render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {
                  const oldAutoClear = renderer.autoClear; renderer.autoClear = false;
                  let oldClearColor, oldClearAlpha, oldOverrideMaterial;
                  if ( this.overrideMaterial !== undefined ) {
                      oldOverrideMaterial = this.scene.overrideMaterial; this.scene.overrideMaterial = this.overrideMaterial;
                  }
                  if ( this.clearColor !== undefined ) {
                      oldClearColor = renderer.getClearColor( new THREE.Color() ); oldClearAlpha = renderer.getClearAlpha();
                      renderer.setClearColor( this.clearColor, this.clearAlpha );
                  }
                  if ( this.clearDepth ) renderer.clearDepth();
                  renderer.setRenderTarget( this.renderToScreen ? null : readBuffer );
                  if ( this.clear ) renderer.clear( renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil );
                  renderer.render( this.scene, this.camera );
                  if ( this.clearColor !== undefined ) renderer.setClearColor( oldClearColor, oldClearAlpha );
                  if ( this.overrideMaterial !== undefined ) this.scene.overrideMaterial = oldOverrideMaterial;
                  renderer.autoClear = oldAutoClear;
              }
          }

          const LuminosityHighPassShader = {
              uniforms: { 'tDiffuse': { value: null }, 'luminosityThreshold': { value: 1.0 }, 'smoothWidth': { value: 1.0 }, 'defaultColor': { value: new THREE.Color( 0x000000 ) }, 'defaultOpacity': { value: 0.0 } },
              vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
              fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 defaultColor; uniform float defaultOpacity; uniform float luminosityThreshold; uniform float smoothWidth; varying vec2 vUv; void main() { vec4 texel = texture2D( tDiffuse, vUv ); vec3 luma = vec3( 0.299, 0.587, 0.114 ); float v = dot( texel.xyz, luma ); vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity ); float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v ); gl_FragColor = mix( outputColor, texel, alpha ); }`
          };

          class UnrealBloomPass extends Pass {
              constructor( resolution, strength, radius, threshold ) {
                  super();
                  this.strength = ( strength !== undefined ) ? strength : 1;
                  this.radius = radius; this.threshold = threshold;
                  this.resolution = ( resolution !== undefined ) ? new THREE.Vector2( resolution.x, resolution.y ) : new THREE.Vector2( 256, 256 );
                  this.clearColor = new THREE.Color( 0, 0, 0 ); this.needsSwap = false;
                  const pars = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType };
                  this.renderTargetsHorizontal = []; this.renderTargetsVertical = []; this.nMips = 5;
                  let resx = Math.round( this.resolution.x / 2 ), resy = Math.round( this.resolution.y / 2 );
                  this.renderTargetBright = new THREE.WebGLRenderTarget( resx, resy, pars );
                  this.renderTargetBright.texture.generateMipmaps = false;

                  for ( let i = 0; i < this.nMips; i ++ ) {
                      const rtH = new THREE.WebGLRenderTarget( resx, resy, pars ); rtH.texture.generateMipmaps = false; this.renderTargetsHorizontal.push( rtH );
                      const rtV = new THREE.WebGLRenderTarget( resx, resy, pars ); rtV.texture.generateMipmaps = false; this.renderTargetsVertical.push( rtV );
                      resx = Math.round( resx / 2 ); resy = Math.round( resy / 2 );
                  }

                  this.highPassUniforms = THREE.UniformsUtils.clone( LuminosityHighPassShader.uniforms );
                  this.highPassUniforms[ 'luminosityThreshold' ].value = threshold;
                  this.highPassUniforms[ 'smoothWidth' ].value = 0.01;
                  this.materialHighPassFilter = new THREE.ShaderMaterial( {
                      uniforms: this.highPassUniforms, vertexShader: LuminosityHighPassShader.vertexShader, fragmentShader: LuminosityHighPassShader.fragmentShader
                  } );

                  this.separableBlurMaterials = [];
                  const kernelSizeArray = [ 3, 5, 7, 9, 11 ];
                  resx = Math.round( this.resolution.x / 2 ); resy = Math.round( this.resolution.y / 2 );
                  for ( let i = 0; i < this.nMips; i ++ ) {
                      this.separableBlurMaterials.push( this.getSeperableBlurMaterial( kernelSizeArray[ i ] ) );
                      this.separableBlurMaterials[ i ].uniforms[ 'texSize' ].value = new THREE.Vector2( resx, resy );
                      resx = Math.round( resx / 2 ); resy = Math.round( resy / 2 );
                  }

                  this.compositeMaterial = this.getCompositeMaterial( this.nMips );
                  this.compositeMaterial.uniforms[ 'blurTexture1' ].value = this.renderTargetsVertical[ 0 ].texture;
                  this.compositeMaterial.uniforms[ 'blurTexture2' ].value = this.renderTargetsVertical[ 1 ].texture;
                  this.compositeMaterial.uniforms[ 'blurTexture3' ].value = this.renderTargetsVertical[ 2 ].texture;
                  this.compositeMaterial.uniforms[ 'blurTexture4' ].value = this.renderTargetsVertical[ 3 ].texture;
                  this.compositeMaterial.uniforms[ 'blurTexture5' ].value = this.renderTargetsVertical[ 4 ].texture;
                  this.compositeMaterial.uniforms[ 'bloomStrength' ].value = strength;
                  this.compositeMaterial.uniforms[ 'bloomRadius' ].value = 0.1;
                  this.compositeMaterial.uniforms[ 'bloomFactors' ].value = [ 1.0, 0.8, 0.6, 0.4, 0.2 ];
                  this.bloomTintColors = [ new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ) ];
                  this.compositeMaterial.uniforms[ 'bloomTintColors' ].value = this.bloomTintColors;

                  this.copyUniforms = THREE.UniformsUtils.clone( CopyShader.uniforms );
                  this.copyUniforms[ 'opacity' ].value = 1.0;
                  this.materialCopy = new THREE.ShaderMaterial( {
                      uniforms: this.copyUniforms, vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
                      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true
                  } );
                  this.fsQuad = new FullScreenQuad( null );
              }
              setSize( width, height ) {
                  let resx = Math.round( width / 2 ), resy = Math.round( height / 2 );
                  this.renderTargetBright.setSize( resx, resy );
                  for ( let i = 0; i < this.nMips; i ++ ) {
                      this.renderTargetsHorizontal[ i ].setSize( resx, resy ); this.renderTargetsVertical[ i ].setSize( resx, resy );
                      this.separableBlurMaterials[ i ].uniforms[ 'texSize' ].value = new THREE.Vector2( resx, resy );
                      resx = Math.round( resx / 2 ); resy = Math.round( resy / 2 );
                  }
              }
              render( renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
                  renderer.getClearColor( this.clearColor ); const oldClearAlpha = renderer.getClearAlpha();
                  const oldAutoClear = renderer.autoClear; renderer.autoClear = false;
                  renderer.setClearColor( new THREE.Color( 0, 0, 0 ), 0 );

                  if ( this.renderToScreen ) {
                      this.fsQuad.material = this.materialCopy; this.copyUniforms[ 'tDiffuse' ].value = readBuffer.texture;
                      renderer.setRenderTarget( null ); renderer.clear(); this.fsQuad.render( renderer );
                  }

                  this.highPassUniforms[ 'tDiffuse' ].value = readBuffer.texture; this.highPassUniforms[ 'luminosityThreshold' ].value = this.threshold;
                  this.fsQuad.material = this.materialHighPassFilter;
                  renderer.setRenderTarget( this.renderTargetBright ); renderer.clear(); this.fsQuad.render( renderer );

                  let inputRenderTarget = this.renderTargetBright;
                  for ( let i = 0; i < this.nMips; i ++ ) {
                      this.fsQuad.material = this.separableBlurMaterials[ i ];
                      this.separableBlurMaterials[ i ].uniforms[ 'colorTexture' ].value = inputRenderTarget.texture;
                      this.separableBlurMaterials[ i ].uniforms[ 'direction' ].value = UnrealBloomPass.BlurDirectionX;
                      renderer.setRenderTarget( this.renderTargetsHorizontal[ i ] ); renderer.clear(); this.fsQuad.render( renderer );

                      this.separableBlurMaterials[ i ].uniforms[ 'colorTexture' ].value = this.renderTargetsHorizontal[ i ].texture;
                      this.separableBlurMaterials[ i ].uniforms[ 'direction' ].value = UnrealBloomPass.BlurDirectionY;
                      renderer.setRenderTarget( this.renderTargetsVertical[ i ] ); renderer.clear(); this.fsQuad.render( renderer );
                      inputRenderTarget = this.renderTargetsVertical[ i ];
                  }

                  this.fsQuad.material = this.compositeMaterial;
                  this.compositeMaterial.uniforms[ 'bloomStrength' ].value = this.strength;
                  this.compositeMaterial.uniforms[ 'bloomRadius' ].value = this.radius;
                  this.compositeMaterial.uniforms[ 'bloomTintColors' ].value = this.bloomTintColors;
                  renderer.setRenderTarget( this.renderTargetsHorizontal[ 0 ] ); renderer.clear(); this.fsQuad.render( renderer );

                  this.fsQuad.material = this.materialCopy; this.copyUniforms[ 'tDiffuse' ].value = this.renderTargetsHorizontal[ 0 ].texture;
                  renderer.setRenderTarget( this.renderToScreen ? null : readBuffer ); this.fsQuad.render( renderer );

                  renderer.setClearColor( this.clearColor, oldClearAlpha ); renderer.autoClear = oldAutoClear;
              }
              getSeperableBlurMaterial( kernelRadius ) {
                  return new THREE.ShaderMaterial( {
                      defines: { 'KERNEL_RADIUS': kernelRadius, 'SIGMA': kernelRadius },
                      uniforms: { 'colorTexture': { value: null }, 'texSize': { value: new THREE.Vector2( 0.5, 0.5 ) }, 'direction': { value: new THREE.Vector2( 0.5, 0.5 ) } },
                      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
                      fragmentShader: `varying vec2 vUv; uniform sampler2D colorTexture; uniform vec2 texSize; uniform vec2 direction; float gaussianPdf(in float x, in float sigma) { return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma; } void main() { vec2 invSize = 1.0 / texSize; float fSigma = float(SIGMA); float weightSum = gaussianPdf(0.0, fSigma); vec3 diffuseSum = texture2D( colorTexture, vUv).rgb * weightSum; for( int i = 1; i < KERNEL_RADIUS; i ++ ) { float x = float(i); float w = gaussianPdf(x, fSigma); vec2 uvOffset = direction * invSize * x; vec3 sample1 = texture2D( colorTexture, vUv + uvOffset).rgb; vec3 sample2 = texture2D( colorTexture, vUv - uvOffset).rgb; diffuseSum += (sample1 + sample2) * w; weightSum += 2.0 * w; } gl_FragColor = vec4(diffuseSum/weightSum, 1.0); }`
                  } );
              }
              getCompositeMaterial( nMips ) {
                  return new THREE.ShaderMaterial( {
                      defines: { 'NUM_MIPS': nMips },
                      uniforms: { 'blurTexture1': { value: null }, 'blurTexture2': { value: null }, 'blurTexture3': { value: null }, 'blurTexture4': { value: null }, 'blurTexture5': { value: null }, 'bloomStrength': { value: 1.0 }, 'bloomFactors': { value: null }, 'bloomTintColors': { value: null }, 'bloomRadius': { value: 0.0 } },
                      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
                      fragmentShader: `varying vec2 vUv; uniform sampler2D blurTexture1; uniform sampler2D blurTexture2; uniform sampler2D blurTexture3; uniform sampler2D blurTexture4; uniform sampler2D blurTexture5; uniform float bloomStrength; uniform float bloomRadius; uniform float bloomFactors[NUM_MIPS]; uniform vec3 bloomTintColors[NUM_MIPS]; float lerpBloomFactor(const in float factor) { float mirrorFactor = 1.2 - factor; return mix(factor, mirrorFactor, bloomRadius); } void main() { gl_FragColor = bloomStrength * ( lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv) + lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv) + lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv) + lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv) + lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv) ); }`
                  } );
              }
          }
          UnrealBloomPass.BlurDirectionX = new THREE.Vector2( 1.0, 0.0 );
          UnrealBloomPass.BlurDirectionY = new THREE.Vector2( 0.0, 1.0 );

          const FXAAShader = {
              uniforms: {
                  'tDiffuse': { value: null },
                  'resolution': { value: new THREE.Vector2() }
              },
              vertexShader: `
                  varying vec2 vUv;
                  void main() {
                      vUv = uv;
                      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
                  }
              `,
              fragmentShader: `
                  uniform sampler2D tDiffuse;
                  uniform vec2 resolution;
                  varying vec2 vUv;
                  #define FXAA_REDUCE_MIN   (1.0/128.0)
                  #define FXAA_REDUCE_MUL   (1.0/8.0)
                  #define FXAA_SPAN_MAX     8.0
                  void main() {
                      vec3 rgbNW = texture2D(tDiffuse, vUv + (vec2(-1.0, -1.0) * resolution)).rgb;
                      vec3 rgbNE = texture2D(tDiffuse, vUv + (vec2(1.0, -1.0) * resolution)).rgb;
                      vec3 rgbSW = texture2D(tDiffuse, vUv + (vec2(-1.0, 1.0) * resolution)).rgb;
                      vec3 rgbSE = texture2D(tDiffuse, vUv + (vec2(1.0, 1.0) * resolution)).rgb;
                      vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;
                      float alphaM = texture2D(tDiffuse, vUv).a;
                      vec3 luma = vec3(0.299, 0.587, 0.114);
                      float lumaNW = dot(rgbNW, luma);
                      float lumaNE = dot(rgbNE, luma);
                      float lumaSW = dot(rgbSW, luma);
                      float lumaSE = dot(rgbSE, luma);
                      float lumaM  = dot(rgbM,  luma);
                      float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
                      float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
                      vec2 dir;
                      dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
                      dir.y = ((lumaNW + lumaSW) - (lumaNE + lumaSE));
                      float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
                      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
                      dir = min(vec2(FXAA_SPAN_MAX, FXAA_SPAN_MAX), max(vec2(-FXAA_SPAN_MAX, -FXAA_SPAN_MAX), dir * rcpDirMin)) * resolution;
                      vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(tDiffuse, vUv + dir * (2.0/3.0 - 0.5)).rgb);
                      vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb + texture2D(tDiffuse, vUv + dir * 0.5).rgb);
                      float lumaB = dot(rgbB, luma);
                      if ((lumaB < lumaMin) || (lumaB > lumaMax)) {
                          gl_FragColor = vec4(rgbA, alphaM);
                      } else {
                          gl_FragColor = vec4(rgbB, alphaM);
                      }
                  }
              `
          };

          class TemporalPass extends Pass {
              constructor(renderer) {
                  super();
                  this.renderer = renderer;
                  const size = renderer.getSize(new THREE.Vector2());
                  this.pixelRatio = renderer.getPixelRatio();
                  const pars = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat };
                  this.accumTarget1 = new THREE.WebGLRenderTarget(size.width * this.pixelRatio, size.height * this.pixelRatio, pars);
                  this.accumTarget2 = new THREE.WebGLRenderTarget(size.width * this.pixelRatio, size.height * this.pixelRatio, pars);
                  this.material = new THREE.ShaderMaterial({
                      uniforms: {
                          'tCurrent': { value: null },
                          'tPrev': { value: null },
                          'blend': { value: 0.35 }
                      },
                      vertexShader: `
                          varying vec2 vUv;
                          void main() {
                              vUv = uv;
                              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                          }
                      `,
                      fragmentShader: `
                          uniform sampler2D tCurrent;
                          uniform sampler2D tPrev;
                          uniform float blend;
                          varying vec2 vUv;
                          void main() {
                              vec4 current = texture2D(tCurrent, vUv);
                              vec4 prev = texture2D(tPrev, vUv);
                              gl_FragColor = mix(current, prev, blend);
                          }
                      `
                  });
                  this.fsQuad = new FullScreenQuad(this.material);
                  this.copyMaterial = new THREE.ShaderMaterial({
                      uniforms: { 'tDiffuse': { value: null } },
                      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
                      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`
                  });
                  this.copyQuad = new FullScreenQuad(this.copyMaterial);
              }
              setSize(width, height) {
                  this.accumTarget1.setSize(width, height);
                  this.accumTarget2.setSize(width, height);
              }
              render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
                  this.material.uniforms['tCurrent'].value = readBuffer.texture;
                  this.material.uniforms['tPrev'].value = this.accumTarget1.texture;
                  renderer.setRenderTarget(this.accumTarget2);
                  renderer.clear();
                  this.fsQuad.render(renderer);
                  this.copyMaterial.uniforms['tDiffuse'].value = this.accumTarget2.texture;
                  if (this.renderToScreen) {
                      renderer.setRenderTarget(null);
                      this.copyQuad.render(renderer);
                  } else {
                      renderer.setRenderTarget(writeBuffer);
                      renderer.clear();
                      this.copyQuad.render(renderer);
                  }
                  const temp = this.accumTarget1;
                  this.accumTarget1 = this.accumTarget2;
                  this.accumTarget2 = temp;
              }
          }

          return { THREE, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, FXAAShader, TemporalPass };
        })
        .catch(err => { threeModulePromise = null; threeLoadFailed = true; throw err; });
    }
    return threeModulePromise;
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
    uniform float uAmp;
    uniform float uFreq;
    varying float vDisplacement;
    ${NOISE_GLSL}

    void main() {
      vec3 noisePos = position * uFreq + vec3(uTime * 0.25);
      float displacement = pnoise(noisePos) * uAmp;
      vDisplacement = displacement;
      vec3 newPosition = position + normal * displacement;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
    }
  `;

  const BLOB_FRAGMENT = `
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    varying float vDisplacement;

    void main() {
      float t = clamp(vDisplacement * 0.5 + 0.5, 0.0, 1.0);
      gl_FragColor = vec4(mix(uColorA, uColorB, t), 1.0);
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
  let temporalPass  = null;
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

    const { THREE, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, FXAAShader, TemporalPass } = mod;
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
    const pr = tier.pixelRatio;
    blobRenderer.setPixelRatio(pr);
    blobRenderer.setSize(W, H, false);

    const geometry = new THREE.IcosahedronGeometry(1.8, 16);
    const [colorA, colorB] = accentColorsToVec3(THREE);

    blobMaterial = new THREE.ShaderMaterial({
      vertexShader: BLOB_VERTEX,
      fragmentShader: BLOB_FRAGMENT,
      wireframe: true,
      uniforms: {
        uTime:   { value: 0 },
        uAmp:    { value: 0.15 },
        uFreq:   { value: 1.4 },
        uColorA: { value: colorA },
        uColorB: { value: colorB },
      },
    });

    blobMesh = new THREE.Mesh(geometry, blobMaterial);
    blobScene.add(blobMesh);

    const coreMaterial = new THREE.ShaderMaterial({
      vertexShader: BLOB_VERTEX,
      fragmentShader: `void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }`,
      uniforms: blobMaterial.uniforms,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    coreMesh = new THREE.Mesh(geometry, coreMaterial);
    coreMesh.scale.set(0.97, 0.97, 0.97);
    blobScene.add(coreMesh);

    blobComposer = new EffectComposer(blobRenderer);
    blobComposer.addPass(new RenderPass(blobScene, blobCamera));

    const bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), 0.85, 0.4, 0.1);
    blobComposer.addPass(bloomPass);

    const aaType = localStorage.getItem('musik_aa_type') || 'msaa';
    if (tier.fxaa && aaType === 'fxaa') {
      fxaaPass = new ShaderPass(FXAAShader);
      fxaaPass.uniforms['resolution'].value.set(1 / (W * pr), 1 / (H * pr));
      blobComposer.addPass(fxaaPass);
    } else {
      fxaaPass = null;
    }

    if (tier.temporal) {
      temporalPass = new TemporalPass(blobRenderer);
      blobComposer.addPass(temporalPass);
    } else {
      temporalPass = null;
    }

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

    blobClock = new THREE.Clock();
  }

  function draw3d(analyser, mount) {
    if (!blobRenderer) {
      if (!blobSceneLoading) ensureScene3d(mount);
      return;
    }

    let bass, treble;
    if (analyser) {
      if (!draw3d._freqData || draw3d._freqData.length !== analyser.frequencyBinCount) {
        draw3d._freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(draw3d._freqData);
      bass = bandEnergy(draw3d._freqData, 0, 0.15);
      treble = bandEnergy(draw3d._freqData, 0.35, 0.8);
    } else {
      const t = performance.now() / 1000;
      bass = 0.16 + Math.sin(t * 0.15) * 0.05;
      treble = 0.12 + Math.sin(t * 0.11 + 1.7) * 0.04;
    }

    draw3d._smoothedBass = draw3d._smoothedBass || 0;
    draw3d._smoothedBass = bass > draw3d._smoothedBass
      ? draw3d._smoothedBass * 0.4 + bass * 0.6
      : draw3d._smoothedBass * 0.88 + bass * 0.12;
    const smoothedBass = draw3d._smoothedBass;

    const [ar, ag, ab] = getAccentRgb().split(',').map((n) => parseInt(n.trim(), 10) || 0);
    const [br, bg, bb] = hueShiftRgb(ar, ag, ab, 20);
    blobMaterial.uniforms.uColorA.value.setRGB(ar / 255, ag / 255, ab / 255);
    blobMaterial.uniforms.uColorB.value.setRGB(br / 255, bg / 255, bb / 255);

    const sensitivity = parseFloat(localStorage.getItem('musik_vis_sensitivity') || '1.0');
    const delta = Math.min(blobClock.getDelta(), 0.1);
    const time = blobClock.getElapsedTime();

    blobMaterial.uniforms.uTime.value = time;
    blobMaterial.uniforms.uAmp.value = (0.1 + smoothedBass * 0.9) * 0.18 * sensitivity;
    blobMaterial.uniforms.uFreq.value = 1.2 + treble * 1.5;

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
    if (temporalPass) {
      temporalPass.accumTarget1?.dispose();
      temporalPass.accumTarget2?.dispose();
      temporalPass.fsQuad?.dispose();
      temporalPass.copyQuad?.dispose();
      temporalPass = null;
    }

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
  };

  window.MusikVisualizer3D = { isAvailable: () => !threeLoadFailed };
})();
