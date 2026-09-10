/**
 * GTExplorer web viewer — GT-CAR mesh + GT-CTEX texture mapping.
 *
 * Matches desktop GTExplorer (gl_viewer / gtcar_render):
 *  - Per-face palette_index from UV polygon stream
 *  - Vertical CLUT atlas (256×256 per row)
 *  - UV = (x+0.5)/256, (y+0.5)/256  (no V-flip)
 *  - Palette index 0 / CLUT colour 0 = transparent (alphaTest)
 */
// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let currentScene, currentCamera, currentRenderer, currentControls;
let activeModelMesh = null;
let currentTextureCanvas = null;
let currentCtx = null;
let activeSwatchIndex = 0;
let currentAtlasMeta = null; // { usedKeys, keyToRow, nRows }
let loadGeneration = 0; // bumps on every switchModel to drop stale async loads

const BASE_PATH = window.location.pathname.substring(
  0,
  window.location.pathname.lastIndexOf("/") + 1
);

const MODEL_MANIFEST = {
  _npron: {
    car: `${BASE_PATH}mdl/_npron.car`,
    tex: `${BASE_PATH}mdl/_npron.tex`,
  },
  _npron_night: {
    car: `${BASE_PATH}mdl/_npron_night.car`,
    tex: `${BASE_PATH}mdl/_npron_night.tex`,
  },
  _npror: {
    car: `${BASE_PATH}mdl/_npror.car`,
    tex: `${BASE_PATH}mdl/_npror.tex`,
  },
  _npror_night: {
    car: `${BASE_PATH}mdl/_npror_night.car`,
    tex: `${BASE_PATH}mdl/_npror_night.tex`,
  },
};

const FACTORY_COLORS = [
  { name: "Racing Red", hex: "#E60012", rgb: [230, 0, 18] },
  { name: "Sunsia Yellow", hex: "#FFD700", rgb: [255, 215, 0] },
  { name: "Gran Turismo Blue", hex: "#0055FF", rgb: [0, 85, 255] },
  { name: "Midnight Black", hex: "#111116", rgb: [17, 17, 22] },
];

let paletteSlots = [
  { r: 230, g: 0, b: 18 },
  { r: 255, g: 215, b: 0 },
  { r: 0, g: 85, b: 255 },
  { r: 255, g: 255, b: 255 },
];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initThreeJSContainer();
  bindUIControls();
  switchModel("_npron");
});

function initThreeJSContainer() {
  const container =
    document.getElementById("model-viewer-container") || document.body;

  currentScene = new THREE.Scene();
  currentScene.background = new THREE.Color(0x0b0e14);

  currentCamera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight || 1.33,
    0.1,
    1000
  );
  currentCamera.position.set(0, 1.2, 3.5);

  currentRenderer = new THREE.WebGLRenderer({ antialias: true });
  currentRenderer.setSize(
    container.clientWidth || 640,
    container.clientHeight || 480
  );
  currentRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(currentRenderer.domElement);

  if (typeof THREE.OrbitControls !== "undefined") {
    currentControls = new THREE.OrbitControls(
      currentCamera,
      currentRenderer.domElement
    );
    currentControls.enableDamping = true;
  }

  currentScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 10, 7);
  currentScene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-5, 2, -5);
  currentScene.add(fill);

  function animate() {
    requestAnimationFrame(animate);
    if (currentControls) currentControls.update();
    currentRenderer.render(currentScene, currentCamera);
  }
  animate();

  window.addEventListener("resize", () => {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 480;
    currentCamera.aspect = w / h;
    currentCamera.updateProjectionMatrix();
    currentRenderer.setSize(w, h);
  });
}

function bindUIControls() {
  document.querySelectorAll("select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const val = e.target.value;
      if (MODEL_MANIFEST[val]) switchModel(val);
    });
  });
}

// ---------------------------------------------------------------------------
// Model load
// ---------------------------------------------------------------------------
function disposeMesh(mesh) {
  if (!mesh) return;
  if (mesh.parent) mesh.parent.remove(mesh);
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  }
}

/** Remove every Mesh from the scene (keeps lights/helpers). */
function clearModelMeshes() {
  if (!currentScene) return;
  const toRemove = [];
  currentScene.traverse((obj) => {
    if (obj.isMesh) toRemove.push(obj);
  });
  for (const m of toRemove) disposeMesh(m);
  activeModelMesh = null;
}

async function switchModel(modelKey) {
  const modelData = MODEL_MANIFEST[modelKey];
  if (!modelData || !currentScene) return;

  // Invalidate any in-flight load from a previous selection
  const myGen = ++loadGeneration;

  clearModelMeshes();
  currentTextureCanvas = null;
  currentAtlasMeta = null;

  try {
    const carRes = await fetch(modelData.car);
    if (myGen !== loadGeneration) return; // superseded
    if (!carRes.ok) throw new Error(`HTTP ${carRes.status} loading ${modelData.car}`);
    const carBuffer = await carRes.arrayBuffer();
    if (myGen !== loadGeneration) return;

    const parsed = parseGT1CarFaces(carBuffer);
    if (!parsed) {
      console.error("[Viewer] Failed to parse GT-CAR");
      return;
    }
    if (myGen !== loadGeneration) return;

    let material;
    let keyToRow = new Map([[0, 0]]);
    let nRows = 1;

    try {
      const texRes = await fetch(modelData.tex);
      if (myGen !== loadGeneration) return;
      if (texRes.ok) {
        const texBuffer = await texRes.arrayBuffer();
        if (myGen !== loadGeneration) return;

        // Desktop masks palette_index with & 0x0F (CLUT 0..15 within set).
        // Always atlas all 16 CLUTs so headlights / decals / glass never fall
        // back to the body row when a face references a less-used CLUT.
        const usedSet = new Set();
        for (const f of parsed.faces) {
          usedSet.add(f.pidx & 0x0f);
        }
        const usedKeys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        console.log(
          "[Viewer] face CLUTs used:",
          [...usedSet].sort((a, b) => a - b).join(", ")
        );

        const atlas = generateTexAtlas(texBuffer, 0, usedKeys);
        if (myGen !== loadGeneration) return;

        currentTextureCanvas = atlas.canvas;
        currentAtlasMeta = atlas;
        keyToRow = atlas.keyToRow;
        nRows = atlas.nRows;

        const texture = new THREE.CanvasTexture(atlas.canvas);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.flipY = false;

        material = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.35,
          metalness: 0.1,
          side: THREE.DoubleSide,
          transparent: true,
          alphaTest: 0.5,
        });
      }
    } catch (texErr) {
      console.warn("[Viewer] Texture load failed:", texErr);
    }

    if (myGen !== loadGeneration) return;

    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0x909090,
        roughness: 0.5,
        metalness: 0.2,
        side: THREE.DoubleSide,
      });
    }

    // Clear again in case a stale load slipped a mesh in
    clearModelMeshes();

    const geometry = buildGeometryFromFaces(parsed, keyToRow, nRows);
    activeModelMesh = new THREE.Mesh(geometry, material);
    currentScene.add(activeModelMesh);

    geometry.computeBoundingSphere();
    if (geometry.boundingSphere) {
      const r = geometry.boundingSphere.radius || 1;
      currentCamera.position.set(0, r * 0.6, r * 3.2);
      if (currentControls) {
        currentControls.target.set(0, 0, 0);
        currentControls.update();
      }
    }

    if (currentTextureCanvas) {
      initPaletteEditor(activeModelMesh, currentTextureCanvas);
    }

    console.log(
      `[Viewer] ${modelKey}: ${parsed.faces.length} UV faces, atlas rows=${nRows}`
    );
  } catch (err) {
    if (myGen === loadGeneration) {
      console.error("[Viewer] Failure loading car model:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// GT-CAR face parser (collects verts + UV faces with palette_index)
// ---------------------------------------------------------------------------
function parseGT1CarFaces(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Find @(#)GT-CAR
  let headerOffset = -1;
  for (let i = 0; i < Math.min(buffer.byteLength - 10, 64); i++) {
    if (
      bytes[i] === 0x40 &&
      bytes[i + 1] === 0x28 &&
      bytes[i + 2] === 0x23 &&
      bytes[i + 3] === 0x29 &&
      bytes[i + 4] === 0x47 &&
      bytes[i + 5] === 0x54 &&
      bytes[i + 6] === 0x2d &&
      bytes[i + 7] === 0x43 &&
      bytes[i + 8] === 0x41 &&
      bytes[i + 9] === 0x52
    ) {
      headerOffset = i;
      break;
    }
  }
  if (headerOffset === -1) {
    console.error("[GT1 Parser] Missing @(#)GT-CAR magic");
    return null;
  }

  // Header: 0x10 + 4 wheels (32) + menu dims (8) + pad (4) + lod_count + 0x42
  let ptr = headerOffset + 0x10 + 32 + 8;
  ptr += 4;
  const lodCount = view.getUint16(ptr, true);
  ptr += 2 + 0x42;

  if (lodCount < 1 || lodCount > 8) {
    console.error(`[GT1 Parser] Invalid LOD count: ${lodCount}`);
    return null;
  }

  const vertexCount = view.getUint16(ptr + 0, true);
  const normalCount = view.getUint16(ptr + 2, true);
  const triangleCount = view.getUint16(ptr + 4, true);
  const quadCount = view.getUint16(ptr + 6, true);
  const uvTriangleCount = view.getUint16(ptr + 12, true);
  const uvQuadCount = view.getUint16(ptr + 14, true);
  const rawScale = view.getUint16(ptr + 36, true);
  ptr += 40;

  const UNITS_TO_METRES = 1.0 / 4096.0;
  const scaleAmount = rawScale - 16;
  const scaleFactor =
    (scaleAmount < 0 ? 1.0 / (1 << -scaleAmount) : 1 << scaleAmount) *
    UNITS_TO_METRES;

  // Vertices
  const vertices = [];
  for (let i = 0; i < vertexCount; i++) {
    if (ptr + 8 > buffer.byteLength) break;
    const x = view.getInt16(ptr, true) * scaleFactor;
    const y = view.getInt16(ptr + 2, true) * scaleFactor;
    const z = -view.getInt16(ptr + 4, true) * scaleFactor; // GT1 Z flip
    vertices.push([x, y, z]);
    ptr += 8;
  }

  ptr += normalCount * 8;
  ptr += triangleCount * 16; // untextured tris
  ptr += quadCount * 16; // untextured quads

  function unpackFaceVertices(p) {
    const b0 = bytes[p],
      b1 = bytes[p + 1],
      b2 = bytes[p + 2];
    const b3 = bytes[p + 3],
      b4 = bytes[p + 4],
      b5 = bytes[p + 5];
    const v0 = (b1 & 1) * 256 + b0;
    const v1 = (b2 & 2) * 128 + (b2 & 1) * 128 + (b1 >> 1);
    const v2 = (b3 & 4) * 64 + (b3 & 2) * 64 + (b3 & 1) * 64 + (b2 >> 2);
    const v3 = (b5 & 1) * 256 + b4;
    return [
      vertices[v0] || vertices[0],
      vertices[v1] || vertices[0],
      vertices[v2] || vertices[0],
      vertices[v3] || vertices[0],
    ];
  }

  /**
   * UV face layout after 16-byte base (verts+normals+face type):
   *   +0  uv0.x, uv0.y
   *   +2  raw_pal (u16 LE) → palette_index = (raw>>4)+(raw&0x3F)
   *   +4  uv1.x, uv1.y
   *   +6  unk, unk
   *   +8  uv2.x, uv2.y
   *   +10 uv3.x, uv3.y
   * Total face = 28 bytes
   */
  const faces = [];

  for (let i = 0; i < uvTriangleCount; i++) {
    if (ptr + 28 > buffer.byteLength) break;
    const [v0, v1, v2] = unpackFaceVertices(ptr);
    const uv0x = bytes[ptr + 16];
    const uv0y = bytes[ptr + 17];
    const rawPal = view.getUint16(ptr + 18, true);
    const pidx = ((rawPal >> 4) + (rawPal & 0x3f)) | 0;
    const uv1x = bytes[ptr + 20];
    const uv1y = bytes[ptr + 21];
    const uv2x = bytes[ptr + 24];
    const uv2y = bytes[ptr + 25];
    faces.push({
      verts: [v0, v1, v2],
      uvsRaw: [
        [uv0x, uv0y],
        [uv1x, uv1y],
        [uv2x, uv2y],
      ],
      pidx,
      isQuad: false,
    });
    ptr += 28;
  }

  for (let i = 0; i < uvQuadCount; i++) {
    if (ptr + 28 > buffer.byteLength) break;
    const [v0, v1, v2, v3] = unpackFaceVertices(ptr);
    const uv0x = bytes[ptr + 16];
    const uv0y = bytes[ptr + 17];
    const rawPal = view.getUint16(ptr + 18, true);
    const pidx = ((rawPal >> 4) + (rawPal & 0x3f)) | 0;
    const uv1x = bytes[ptr + 20];
    const uv1y = bytes[ptr + 21];
    const uv2x = bytes[ptr + 24];
    const uv2y = bytes[ptr + 25];
    const uv3x = bytes[ptr + 26];
    const uv3y = bytes[ptr + 27];
    faces.push({
      verts: [v0, v1, v2, v3],
      uvsRaw: [
        [uv0x, uv0y],
        [uv1x, uv1y],
        [uv2x, uv2y],
        [uv3x, uv3y],
      ],
      pidx,
      isQuad: true,
    });
    ptr += 28;
  }

  console.log(
    `[GT1 Parser] LOD0: ${vertexCount} verts, ${uvTriangleCount} UV tris, ${uvQuadCount} UV quads`
  );
  return { faces, scaleFactor };
}

// ---------------------------------------------------------------------------
// Geometry from faces + atlas row mapping
// ---------------------------------------------------------------------------
function uvNorm(x, y, row, nRows) {
  // Match desktop GL / software raster (no V-flip)
  const u = (x + 0.5) / 256.0;
  const vLocal = (y + 0.5) / 256.0;
  const v = (row + vLocal) / Math.max(1, nRows);
  return [u, v];
}

function buildGeometryFromFaces(parsed, keyToRow, nRows) {
  const positions = [];
  const uvs = [];

  const pushCorner = (vert, uvxy, pidx) => {
    positions.push(vert[0], vert[1], vert[2]);
    // Match desktop collect_palette_usage: palette_index & 0x0F
    const key = pidx & 0x0f;
    const row = keyToRow.has(key) ? keyToRow.get(key) : key;
    const [u, v] = uvNorm(uvxy[0], uvxy[1], row, nRows);
    uvs.push(u, v);
  };

  for (const f of parsed.faces) {
    // tri 0-1-2
    pushCorner(f.verts[0], f.uvsRaw[0], f.pidx);
    pushCorner(f.verts[1], f.uvsRaw[1], f.pidx);
    pushCorner(f.verts[2], f.uvsRaw[2], f.pidx);
    if (f.isQuad) {
      // tri 0-2-3
      pushCorner(f.verts[0], f.uvsRaw[0], f.pidx);
      pushCorner(f.verts[2], f.uvsRaw[2], f.pidx);
      pushCorner(f.verts[3], f.uvsRaw[3], f.pidx);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.center();
  return geometry;
}

// ---------------------------------------------------------------------------
// GT-CTEX → vertical palette atlas
// ---------------------------------------------------------------------------
/**
 * Decode 4bpp image once, then expand with each requested CLUT into a
 * stacked atlas (256 wide × 256*nRows tall).
 *
 * @param {ArrayBuffer} buffer  raw .tex
 * @param {number} paletteSet   colour / palette-set index (usually 0)
 * @param {number[]} usedKeys   CLUT indices to include (e.g. [0,1,3,14])
 */
function generateTexAtlas(buffer, paletteSet, usedKeys) {
  const IMAGE_OFF = 0x60;
  const IMAGE_SIZE = (256 * 256) / 2;
  const PAL_OFF = 0x8060;
  const PAL_STRIDE = 512; // 16 CLUTs × 32 bytes
  const CLUT_SIZE = 32;

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let setCount = 1;
  if (buffer.byteLength >= 0x10) {
    setCount = Math.max(1, view.getUint16(0x0e, true) || 1);
  }
  paletteSet = Math.max(0, Math.min(paletteSet, setCount - 1));

  if (!usedKeys || usedKeys.length === 0) {
    usedKeys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  }
  // Row index = position in usedKeys (identity when usedKeys is 0..15)
  const keyToRow = new Map(usedKeys.map((k, i) => [k & 0x0f, i]));
  const nRows = usedKeys.length;

  // 4bpp indices
  const indices = new Uint8Array(256 * 256);
  if (buffer.byteLength >= IMAGE_OFF + IMAGE_SIZE) {
    let pi = 0;
    for (let i = IMAGE_OFF; i < IMAGE_OFF + IMAGE_SIZE; i++) {
      const b = bytes[i];
      indices[pi++] = b & 0x0f;
      indices[pi++] = (b >> 4) & 0x0f;
    }
  }

  function readClut(clutIndex) {
    let off = PAL_OFF + paletteSet * PAL_STRIDE + clutIndex * CLUT_SIZE;
    if (off + CLUT_SIZE > buffer.byteLength) {
      off = 0x20; // legacy fallback
    }
    const pal = [];
    for (let c = 0; c < 16; c++) {
      if (off + c * 2 + 1 >= buffer.byteLength) {
        pal.push([128, 128, 128, 255]);
        continue;
      }
      const c16 = view.getUint16(off + c * 2, true);
      const r = (c16 & 0x1f) << 3;
      const g = ((c16 >> 5) & 0x1f) << 3;
      const b = ((c16 >> 10) & 0x1f) << 3;
      // PS1 / GT: colour 0 is transparent
      const a = c16 === 0 ? 0 : 255;
      pal.push([r, g, b, a]);
    }
    return pal;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256 * nRows;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(256, 256 * nRows);
  const data = imgData.data;

  for (let row = 0; row < nRows; row++) {
    const pal = readClut(usedKeys[row] % 16);
    const base = row * 256 * 256 * 4;
    for (let p = 0; p < 256 * 256; p++) {
      const col = pal[indices[p]] || [0, 0, 0, 255];
      const o = base + p * 4;
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = col[3];
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return { canvas, usedKeys, keyToRow, nRows };
}

// Keep old single-CLUT helper for any external callers / palette editor preview
function generateTexCanvas(buffer, paletteIndex = 0, clutIndex = 0) {
  const atlas = generateTexAtlas(buffer, paletteIndex, [clutIndex]);
  // Return a 256×256 slice of row 0
  const src = atlas.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, 0, 0, 256, 256, 0, 0, 256, 256);
  return canvas;
}

// ---------------------------------------------------------------------------
// Palette editor UI (demo recolour of reddish body pixels)
// ---------------------------------------------------------------------------
function initPaletteEditor(mesh, textureCanvas) {
  currentCtx = textureCanvas.getContext("2d");

  const colorPicker = document.getElementById("palettePicker");
  const hexLabel = document.querySelector(".hex-code");

  if (colorPicker) {
    colorPicker.addEventListener("input", (e) => {
      const hex = e.target.value;
      if (hexLabel) hexLabel.textContent = hex.toUpperCase();
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      updateActiveSwatch(r, g, b);
      applyPaletteToCanvas(r, g, b);
    });
  }

  document.querySelectorAll(".swatch-slot").forEach((slot, index) => {
    slot.addEventListener("click", () => {
      document
        .querySelectorAll(".swatch-slot")
        .forEach((s) => s.classList.remove("active"));
      slot.classList.add("active");
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
  document.querySelectorAll(".swatch").forEach((swatch, idx) => {
    if (paletteSlots[idx]) {
      const { r, g, b } = paletteSlots[idx];
      swatch.style.backgroundColor = `rgb(${r},${g},${b})`;
    }
  });
}

function applyPaletteToCanvas(targetR, targetG, targetB) {
  if (!currentCtx || !currentTextureCanvas) return;

  const imgData = currentCtx.getImageData(
    0,
    0,
    currentTextureCanvas.width,
    currentTextureCanvas.height
  );
  const data = imgData.data;

  // Simple body-paint heuristic (same as before) — for a full editor you'd
  // rewrite CLUT entries and rebuild the atlas.
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 100 && g < 80 && b < 80) {
      const factor = r / 255;
      data[i] = Math.min(255, targetR * factor);
      data[i + 1] = Math.min(255, targetG * factor);
      data[i + 2] = Math.min(255, targetB * factor);
    }
  }

  currentCtx.putImageData(imgData, 0, 0);
  if (activeModelMesh && activeModelMesh.material && activeModelMesh.material.map) {
    activeModelMesh.material.map.needsUpdate = true;
  }
}

function applyPresetColor(presetIndex) {
  const preset = FACTORY_COLORS[presetIndex];
  if (!preset) return;
  const colorPicker = document.getElementById("palettePicker");
  const hexLabel = document.querySelector(".hex-code");
  if (colorPicker) colorPicker.value = preset.hex;
  if (hexLabel) hexLabel.textContent = preset.hex;
  const [r, g, b] = preset.rgb;
  updateActiveSwatch(r, g, b);
  applyPaletteToCanvas(r, g, b);
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const h = x.toString(16);
        return h.length === 1 ? "0" + h : h;
      })
      .join("")
  );
}