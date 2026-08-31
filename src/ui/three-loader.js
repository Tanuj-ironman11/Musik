// Loads three.js as an ES module (via the importmap in index.html) and
// re-exposes it as window.THREE for the classic (non-module) scripts
// that still expect a global — fullscreen.js, visualizer.js,
// accent-extractor.js. Replaces the old UMD build/three.min.js script
// tag, which three.js removed as of r160+.
import * as THREE from "three";
window.THREE = THREE;
