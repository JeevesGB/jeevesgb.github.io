/**
 * 
 *      Renders a Gran Turismo 1 .car file. TODO: map textures and apply palettes correctly
 * 
 */
// Global State & Variables
let currentScene, currentCamera, currentRenderer, currentControls;
let activeModelMesh = null;
let currentTextureCanvas = null;
let currentCtx = null;
let activeSwatchIndex = 0;

// Dynamic BASE_PATH calculation prevents nested path issues
const BASE_PATH = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);

// Model Registry mapping options to files in /mdl
const MODEL_MANIFEST = {
  '_npron': { car: `${BASE_PATH}mdl/_npron.car`, tex: `${BASE_PATH}mdl/_npron.tex` },
  '_npron_night': { car: `${BASE_PATH}mdl/_npron_night.car`, tex: `${BASE_PATH}mdl/_npron_night.tex` },
  '_npror': { car: `${BASE_PATH}mdl/_npror.car`, tex: `${BASE_PATH}mdl/_npror.tex` },
  '_npror_night': { car: `${BASE_PATH}mdl/_npror_night.car`, tex: `${BASE_PATH}mdl/_npror_night.tex` }
};

// Factory preset colors for quick switching (RGB format)
const FACTORY_COLORS = [
  { name: 'Racing Red', hex: '#E60012', rgb: [230, 0, 18] },
  { name: 'Sunsia Yellow', hex: '#FFD700', rgb: [255, 215, 0] },
  { name: 'Gran Turismo Blue', hex: '#0055FF', rgb: [0, 85, 255] },
  { name: 'Midnight Black', hex: '#111116', rgb: [17, 17, 22] }
];

// Interactive Palette Memory (4 Slot Demo Strip)
let paletteSlots = [
  { r: 230, g: 0, b: 18 },   // Slot 1
  { r: 255, g: 215, b: 0 },  // Slot 2
  { r: 0, g: 85, b: 255 },   // Slot 3
  { r: 255, g: 255, b: 255 } // Slot 4
];

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initThreeJSContainer();
  bindUIControls();
  switchModel('_npron');
});

/**
 * Initializes Three.js Scene, Camera, Renderer, and Lights
 */
function initThreeJSContainer() {
  const container = document.getElementById('model-viewer-container') || document.body;

  // 1. Scene & Camera Setup
  currentScene = new THREE.Scene();
  currentScene.background = new THREE.Color(0x0b0e14);

  currentCamera = new THREE.PerspectiveCamera(
    45, 
    container.clientWidth / container.clientHeight || 1.33, 
    0.1, 
    1000
  );
  currentCamera.position.set(0, 1.2, 3.5);

  // 2. WebGL Renderer
  currentRenderer = new THREE.WebGLRenderer({ antialias: true });
  currentRenderer.setSize(container.clientWidth || 640, container.clientHeight || 480);
  currentRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(currentRenderer.domElement);

  // 3. Orbit Controls
  if (typeof THREE.OrbitControls !== 'undefined') {
    currentControls = new THREE.OrbitControls(currentCamera, currentRenderer.domElement);
    currentControls.enableDamping = true;
  }

  // 4. Lighting Setup
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
  currentScene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
  sunLight.position.set(5, 10, 7);
  currentScene.add(sunLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  fillLight.position.set(-5, 2, -5);
  currentScene.add(fillLight);

  // 5. Animation Loop
  function animate() {
    requestAnimationFrame(animate);
    if (currentControls) currentControls.update();
    currentRenderer.render(currentScene, currentCamera);
  }
  animate();
}

/**
 * Bind DOM UI Elements
 */
function bindUIControls() {
  const modelSelects = document.querySelectorAll('select');
  modelSelects.forEach(select => {
    select.addEventListener('change', (e) => {
      const val = e.target.value;
      if (MODEL_MANIFEST[val]) switchModel(val);
    });
  });
}

/**
 * Dynamic Model Switcher Logic (Resilient Load Handling)
 */
async function switchModel(modelKey) {
  const modelData = MODEL_MANIFEST[modelKey];
  if (!modelData || !currentScene) return;

  // Clear previous active mesh
  if (activeModelMesh) {
    currentScene.remove(activeModelMesh);
    if (activeModelMesh.geometry) activeModelMesh.geometry.dispose();
    if (activeModelMesh.material) activeModelMesh.material.dispose();
    activeModelMesh = null;
  }

  try {
    // 1. Load .car Mesh File
    const carRes = await fetch(modelData.car);
    if (!carRes.ok) throw new Error(`HTTP ${carRes.status} loading ${modelData.car}`);
    const carBuffer = await carRes.arrayBuffer();

    const geometry = parseGT1Car(carBuffer);
    let material;

    // 2. Load .tex File Safely (Will not crash scene if HTTP fail)
    try {
      const texRes = await fetch(modelData.tex);
      if (texRes.ok) {
        const texBuffer = await texRes.arrayBuffer();
        currentTextureCanvas = generateTexCanvas(texBuffer);
        
        const texture = new THREE.CanvasTexture(currentTextureCanvas);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;

        material = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.35,
          metalness: 0.1,
          side: THREE.DoubleSide,
          transparent: true,
          alphaTest: 0.1 // PS1 index-0 transparency without full sort cost
        });
      }
    } catch (texErr) {
      console.warn('[Viewer] Could not process texture file:', texErr);
    }

    // Default Material Fallback
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0x909090,
        roughness: 0.5,
        metalness: 0.2,
        side: THREE.DoubleSide
      });
    }

    activeModelMesh = new THREE.Mesh(geometry, material);
    currentScene.add(activeModelMesh);

    if (currentTextureCanvas) {
      initPaletteEditor(activeModelMesh, currentTextureCanvas);
    }

  } catch (err) {
    console.error('[Viewer] Failure loading car model:', err);
  }
}

/**
 * GT1 .car Binary Parser
 * Transpiled directly from gtcar.py
 */
function parseGT1Car(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 1. Locate "@(#)GT-CAR" Magic Header
  let headerOffset = -1;
  for (let i = 0; i < Math.min(buffer.byteLength - 10, 64); i++) {
    if (
      bytes[i] === 0x40 && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x23 &&
      bytes[i + 3] === 0x29 && bytes[i + 4] === 0x47 && bytes[i + 5] === 0x54 &&
      bytes[i + 6] === 0x2D && bytes[i + 7] === 0x43 && bytes[i + 8] === 0x41 && bytes[i + 9] === 0x52
    ) {
      headerOffset = i;
      break;
    }
  }

  if (headerOffset === -1) {
    console.error('[GT1 Parser] Could not find @(#)GT-CAR header magic');
    return new THREE.BoxGeometry(1.5, 0.6, 3);
  }

  // 2. Read Header Table
  // Layout matches gtcar.py GTCarModel.from_bytes:
  //   seek 0x10 → 4 wheels (32) → menu dims (8) → 4-byte pad → lod_count → skip 0x42
  let ptr = headerOffset + 0x10 + 32 + 8; // After magic padding + wheels + menu dimensions
  ptr += 4; // 4-byte pad before LOD count (required — without this lodCount reads as 0)
  const lodCount = view.getUint16(ptr, true);
  ptr += 2 + 0x42; // Advance past lod_count + LOD table padding

  if (lodCount < 1 || lodCount > 8) {
    console.error(`[GT1 Parser] Invalid LOD count: ${lodCount}`);
    return new THREE.BoxGeometry(1.5, 0.6, 3);
  }

  // 3. Read LOD0 Counts
  const vertexCount = view.getUint16(ptr + 0, true);
  const normalCount = view.getUint16(ptr + 2, true);
  const triangleCount = view.getUint16(ptr + 4, true);
  const quadCount = view.getUint16(ptr + 6, true);
  const uvTriangleCount = view.getUint16(ptr + 12, true);
  const uvQuadCount = view.getUint16(ptr + 14, true);
  const rawScale = view.getUint16(ptr + 36, true);

  ptr += 40; // Advance to payload data block

  const UNITS_TO_METRES = 1.0 / 4096.0;
  const scaleAmount = rawScale - 16;
  const scaleFactor = (scaleAmount < 0 ? (1.0 / (1 << -scaleAmount)) : (1 << scaleAmount)) * UNITS_TO_METRES;

  // 4. Extract Vertices
  const vertices = [];
  for (let i = 0; i < vertexCount; i++) {
    if (ptr + 8 > buffer.byteLength) break;
    const x = view.getInt16(ptr, true) * scaleFactor;
    const y = view.getInt16(ptr + 2, true) * scaleFactor;
    const z = -view.getInt16(ptr + 4, true) * scaleFactor; // Flip Z for Three.js coordinate system
    vertices.push([x, y, z]);
    ptr += 8;
  }

  // Skip Normals Block
  ptr += normalCount * 8;

  // Skip Untextured Triangles & Quads
  ptr += triangleCount * 16;
  ptr += quadCount * 16;

  const positions = [];
  const uvs = [];

  // Helper function to unpack GT1 bitpacked face vertex indices
  function unpackFaceVertices(p) {
    const b0 = bytes[p], b1 = bytes[p + 1], b2 = bytes[p + 2];
    const b3 = bytes[p + 3], b4 = bytes[p + 4], b5 = bytes[p + 5];

    const v0 = ((b1 & 1) * 256) + b0;
    const v1 = ((b2 & 2) * 128) + ((b2 & 1) * 128) + (b1 >> 1);
    const v2 = ((b3 & 4) * 64) + ((b3 & 2) * 64) + ((b3 & 1) * 64) + (b2 >> 2);
    const v3 = ((b5 & 1) * 256) + b4;

    return [
      vertices[v0] || vertices[0],
      vertices[v1] || vertices[0],
      vertices[v2] || vertices[0],
      vertices[v3] || vertices[0]
    ];
  }

  // 5. Parse Textured Triangles (28 bytes per face)
  for (let i = 0; i < uvTriangleCount; i++) {
    if (ptr + 28 > buffer.byteLength) break;

    const [v0, v1, v2] = unpackFaceVertices(ptr);

    const u0 = bytes[ptr + 16] / 255.0;
    const v0_coord = 1.0 - (bytes[ptr + 17] / 223.0);
    const u1 = bytes[ptr + 20] / 255.0;
    const v1_coord = 1.0 - (bytes[ptr + 21] / 223.0);
    const u2 = bytes[ptr + 24] / 255.0;
    const v2_coord = 1.0 - (bytes[ptr + 25] / 223.0);

    positions.push(...v0, ...v1, ...v2);
    uvs.push(u0, v0_coord, u1, v1_coord, u2, v2_coord);

    ptr += 28;
  }

  // 6. Parse Textured Quads (28 bytes per face, split into 2 Triangles)
  for (let i = 0; i < uvQuadCount; i++) {
    if (ptr + 28 > buffer.byteLength) break;

    const [v0, v1, v2, v3] = unpackFaceVertices(ptr);

    const u0 = bytes[ptr + 16] / 255.0;
    const v0_coord = 1.0 - (bytes[ptr + 17] / 223.0);
    const u1 = bytes[ptr + 20] / 255.0;
    const v1_coord = 1.0 - (bytes[ptr + 21] / 223.0);
    const u2 = bytes[ptr + 24] / 255.0;
    const v2_coord = 1.0 - (bytes[ptr + 25] / 223.0);
    const u3 = bytes[ptr + 26] / 255.0;
    const v3_coord = 1.0 - (bytes[ptr + 27] / 223.0);

    // Tri 1: v0 -> v1 -> v2
    positions.push(...v0, ...v1, ...v2);
    uvs.push(u0, v0_coord, u1, v1_coord, u2, v2_coord);

    // Tri 2: v0 -> v2 -> v3
    positions.push(...v0, ...v2, ...v3);
    uvs.push(u0, v0_coord, u2, v2_coord, u3, v3_coord);

    ptr += 28;
  }

  console.log(`[GT1 Parser] Unpacked ${positions.length / 3} vertices from GT-CAR LOD0`);

  // 7. Construct THREE.js BufferGeometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.center();

  return geometry;
}

/**
 * Direct Stream Fallback Parser for Unaligned GT1 Formats
 */
function parseGT1RawStream(view, length) {
  console.log('[GT1 Parser] Executing raw stream recovery...');
  const positions = [];
  const uvs = [];

  // Sequential scan for vertex streams
  for (let ptr = 0x40; ptr < length - 12; ptr += 12) {
    const x = view.getInt16(ptr + 0, true) / 1000;
    const y = -view.getInt16(ptr + 2, true) / 1000;
    const z = view.getInt16(ptr + 4, true) / 1000;

    // Filter out zero blocks and bounding box limits
    if (Math.abs(x) < 5 && Math.abs(y) < 5 && Math.abs(z) < 5 && (x !== 0 || y !== 0 || z !== 0)) {
      positions.push(x, y, z);
      uvs.push(0, 0);
    }
  }

  if (positions.length < 9) {
    return new THREE.BoxGeometry(1.5, 0.6, 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.center();

  return geometry;
}

/**
 * PS1 .tex CTEX Texture Parser
 * Layout (matches ctex.py):
 *   0x00  @(#)GT-CTEX
 *   0x0E  u16 palette_set_count
 *   0x60  256×256 4bpp image (32768 bytes)
 *   0x8060  palette sets (each 16 CLUTs × 16 colours × 2 bytes BGR555)
 */
function generateTexCanvas(buffer, paletteIndex = 0, clutIndex = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(256, 256);

  const IMAGE_OFF = 0x60;
  const IMAGE_SIZE = 256 * 256 / 2; // 4bpp
  const PAL_OFF = 0x8060;
  const PAL_STRIDE = 512; // 16 CLUTs × 32 bytes
  const CLUT_SIZE = 32;

  if (buffer.byteLength < IMAGE_OFF + IMAGE_SIZE) {
    ctx.fillStyle = '#888888';
    ctx.fillRect(0, 0, 256, 256);
    return canvas;
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Palette set count from header (fallback 1)
  let palCount = 1;
  if (buffer.byteLength >= 0x10) {
    palCount = Math.max(1, view.getUint16(0x0E, true) || 1);
  }
  paletteIndex = Math.max(0, Math.min(paletteIndex, palCount - 1));
  clutIndex = Math.max(0, Math.min(clutIndex, 15));

  // Prefer real CLUT at 0x8060; fall back to legacy offset if file is short
  let clutOffset = PAL_OFF + paletteIndex * PAL_STRIDE + clutIndex * CLUT_SIZE;
  if (clutOffset + CLUT_SIZE > buffer.byteLength) {
    clutOffset = 0x20; // older / truncated assets
  }

  const palette = [];
  for (let c = 0; c < 16; c++) {
    if (clutOffset + c * 2 + 1 >= buffer.byteLength) {
      palette.push([128, 128, 128, 255]);
      continue;
    }
    const color16 = view.getUint16(clutOffset + c * 2, true);
    const r = (color16 & 0x1F) << 3;
    const g = ((color16 >> 5) & 0x1F) << 3;
    const b = ((color16 >> 10) & 0x1F) << 3;
    // Index 0 is typically transparent on PS1
    const a = color16 === 0 ? 0 : 255;
    palette.push([r, g, b, a]);
  }

  // Unpack only the 256×256 4bpp image block
  let pxIndex = 0;
  const texEnd = IMAGE_OFF + IMAGE_SIZE;
  for (let i = IMAGE_OFF; i < texEnd && pxIndex < imgData.data.length; i++) {
    const byte = bytes[i];
    const idx1 = byte & 0x0F;
    const idx2 = (byte >> 4) & 0x0F;

    for (const colorIdx of [idx1, idx2]) {
      const color = palette[colorIdx] || [128, 128, 128, 255];
      imgData.data[pxIndex] = color[0];
      imgData.data[pxIndex + 1] = color[1];
      imgData.data[pxIndex + 2] = color[2];
      imgData.data[pxIndex + 3] = color[3];
      pxIndex += 4;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Initializes Palette Editor Controls
 */
function initPaletteEditor(mesh, textureCanvas) {
  currentCtx = textureCanvas.getContext('2d');
  
  const colorPicker = document.getElementById('palettePicker');
  const hexLabel = document.querySelector('.hex-code');

  if (colorPicker) {
    colorPicker.addEventListener('input', (e) => {
      const hex = e.target.value;
      if (hexLabel) hexLabel.textContent = hex.toUpperCase();

      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);

      updateActiveSwatch(r, g, b);
      applyPaletteToCanvas(r, g, b);
    });
  }

  // Bind Swatches
  const swatches = document.querySelectorAll('.swatch-slot');
  swatches.forEach((slot, index) => {
    slot.addEventListener('click', () => {
      swatches.forEach(s => s.classList.remove('active'));
      slot.classList.add('active');
      activeSwatchIndex = index;

      const currentSlot = paletteSlots[index];
      const hex = rgbToHex(currentSlot.r, currentSlot.g, currentSlot.b);
      if (colorPicker) colorPicker.value = hex;
      if (hexLabel) hexLabel.textContent = hex.toUpperCase();
    });
  });

  refreshSwatchStrip();
}

function updateActiveSwatch(r, g, b) {
  paletteSlots[activeSwatchIndex] = { r, g, b };
  refreshSwatchStrip();
}

function refreshSwatchStrip() {
  const swatches = document.querySelectorAll('.swatch');
  swatches.forEach((swatch, idx) => {
    if (paletteSlots[idx]) {
      const { r, g, b } = paletteSlots[idx];
      swatch.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    }
  });
}

function applyPaletteToCanvas(targetR, targetG, targetB) {
  if (!currentCtx || !currentTextureCanvas) return;

  const imgData = currentCtx.getImageData(0, 0, currentTextureCanvas.width, currentTextureCanvas.height);
  const data = imgData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r > 100 && g < 80 && b < 80) {
      const factor = r / 255;
      data[i]     = Math.min(255, targetR * factor);
      data[i + 1] = Math.min(255, targetG * factor);
      data[i + 2] = Math.min(255, targetB * factor);
    }
  }

  currentCtx.putImageData(imgData, 0, 0);

  if (activeModelMesh && activeModelMesh.material.map) {
    activeModelMesh.material.map.needsUpdate = true;
  }
}

function applyPresetColor(presetIndex) {
  const preset = FACTORY_COLORS[presetIndex];
  if (!preset) return;

  const colorPicker = document.getElementById('palettePicker');
  const hexLabel = document.querySelector('.hex-code');

  if (colorPicker) colorPicker.value = preset.hex;
  if (hexLabel) hexLabel.textContent = preset.hex;

  const [r, g, b] = preset.rgb;
  updateActiveSwatch(r, g, b);
  applyPaletteToCanvas(r, g, b);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}