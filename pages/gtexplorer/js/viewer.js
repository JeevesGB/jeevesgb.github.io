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

  const myGen = ++loadGeneration;

  clearModelMeshes();
  currentTextureCanvas = null;
  currentAtlasMeta = null;

  try {
    const carRes = await fetch(modelData.car);
    if (myGen !== loadGeneration) return;
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

        const usedSet = new Set();
        for (const f of parsed.faces) {
          usedSet.add(f.pidx & 0x0f);
        }
        const usedKeys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

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

    clearModelMeshes();

    const bodyArrays = buildBodyArrays(parsed, keyToRow, nRows);
    const wheelArrays = buildAllWheelArrays(bodyArrays.triplets, parsed.wheels);

    let center = [0, 0, 0];
    if (bodyArrays.triplets.length) {
      const xs = bodyArrays.triplets.map((p) => p[0]);
      const ys = bodyArrays.triplets.map((p) => p[1]);
      const zs = bodyArrays.triplets.map((p) => p[2]);
      center = [
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
        (Math.min(...zs) + Math.max(...zs)) / 2,
      ];
    }

    // Shift body vertices around center
    for (let i = 0; i < bodyArrays.positions.length; i += 3) {
      bodyArrays.positions[i] -= center[0];
      bodyArrays.positions[i + 1] -= center[1];
      bodyArrays.positions[i + 2] -= center[2];
    }

    // Shift wheel vertices with the exact same offset
    for (let i = 0; i < wheelArrays.positions.length; i += 3) {
      wheelArrays.positions[i] -= center[0];
      wheelArrays.positions[i + 1] -= center[1];
      wheelArrays.positions[i + 2] -= center[2];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(bodyArrays.positions, 3)
    );
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(bodyArrays.uvs, 2));
    geometry.computeVertexNormals();

    activeModelMesh = new THREE.Mesh(geometry, material);
    currentScene.add(activeModelMesh);

    if (wheelArrays.positions.length) {
      const wheelGeometry = new THREE.BufferGeometry();
      wheelGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(wheelArrays.positions, 3)
      );
      wheelGeometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(wheelArrays.colors, 3)
      );
      wheelGeometry.setIndex(wheelArrays.indices);
      wheelGeometry.computeVertexNormals();
      const wheelMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.75,
        metalness: 0.15,
        side: THREE.DoubleSide,
      });
      const wheelMesh = new THREE.Mesh(wheelGeometry, wheelMaterial);
      currentScene.add(wheelMesh);
    }

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
      `[Viewer] ${modelKey}: ${parsed.faces.length} UV faces, atlas rows=${nRows}, wheels=${wheelArrays.positions.length ? 4 : 0}`
    );
  } catch (err) {
    if (myGen === loadGeneration) {
      console.error("[Viewer] Failure loading car model:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// GT-CAR face parser
// ---------------------------------------------------------------------------
function parseGT1CarFaces(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

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

  // Raw header wheel positions (fixed 1/4096 unit factor)
  const wheels = [];
  {
    let wp = headerOffset + 0x10;
    for (let w = 0; w < 4; w++) {
      wheels.push({
        x: view.getInt16(wp, true) * UNITS_TO_METRES,
        y: view.getInt16(wp + 2, true) * UNITS_TO_METRES,
        z: view.getInt16(wp + 4, true) * UNITS_TO_METRES,
      });
      wp += 8;
    }
  }

  // Vertices
  const vertices = [];
  for (let i = 0; i < vertexCount; i++) {
    if (ptr + 8 > buffer.byteLength) break;
    const x = view.getInt16(ptr, true) * scaleFactor;
    const y = view.getInt16(ptr + 2, true) * scaleFactor;
    const z = view.getInt16(ptr + 4, true) * scaleFactor;
    vertices.push([x, y, z]);
    ptr += 8;
  }

  ptr += normalCount * 8;
  ptr += triangleCount * 16;
  ptr += quadCount * 16;

  function unpackFaceVertices(p) {
    const b0 = bytes[p],
      b1 = bytes[p + 1],
      b2 = bytes[p + 2];
    const b3 = bytes[p + 3],
      b4 = bytes[p + 4],
      b5 = bytes[p + 5];
    const v0 = (b1 & 1) * 256 + b0;
    const v1 = (b2 & 3) * 128 + (b1 >> 1);
    const v2 = (b3 & 7) * 64 + (b2 >> 2);
    const v3 = (b5 & 1) * 256 + b4;
    return [
      vertices[v0] || vertices[0],
      vertices[v1] || vertices[0],
      vertices[v2] || vertices[0],
      vertices[v3] || vertices[0],
    ];
  }

  const faces = [];

  for (let i = 0; i < uvTriangleCount; i++) {
    if (ptr + 28 > buffer.byteLength) break;
    const [v0, v1, v2] = unpackFaceVertices(ptr);
    const nb2 = bytes[ptr + 7];
    const renderOrder = nb2 & 0x80 ? 0b10001 : 0b10000;
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
      renderOrder,
      isQuad: false,
    });
    ptr += 28;
  }

  for (let i = 0; i < uvQuadCount; i++) {
    if (ptr + 28 > buffer.byteLength) break;
    const [v0, v1, v2, v3] = unpackFaceVertices(ptr);
    const nb2 = bytes[ptr + 7];
    const renderOrder = nb2 & 0x80 ? 0b10001 : 0b10000;
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
      renderOrder,
      isQuad: true,
    });
    ptr += 28;
  }

  faces.sort((a, b) => {
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    return a.pidx - b.pidx;
  });

  return { faces, scaleFactor, wheels };
}

// ---------------------------------------------------------------------------
// Geometry from faces + atlas row mapping
// ---------------------------------------------------------------------------
function uvNorm(x, y, row, nRows) {
  const u = (x + 0.5) / 256.0;
  const vLocal = (y + 0.5) / 256.0;
  const v = (row + vLocal) / Math.max(1, nRows);
  return [u, v];
}

function buildBodyArrays(parsed, keyToRow, nRows) {
  const positions = [];
  const uvs = [];
  const triplets = [];

  const pushCorner = (vert, uvxy, pidx) => {
    positions.push(vert[0], vert[1], vert[2]);
    triplets.push(vert);
    const key = pidx & 0x0f;
    const row = keyToRow.has(key) ? keyToRow.get(key) : key;
    const [u, v] = uvNorm(uvxy[0], uvxy[1], row, nRows);
    uvs.push(u, v);
  };

  for (const f of parsed.faces) {
    pushCorner(f.verts[0], f.uvsRaw[0], f.pidx);
    pushCorner(f.verts[1], f.uvsRaw[1], f.pidx);
    pushCorner(f.verts[2], f.uvsRaw[2], f.pidx);
    if (f.isQuad) {
      pushCorner(f.verts[0], f.uvsRaw[0], f.pidx);
      pushCorner(f.verts[2], f.uvsRaw[2], f.pidx);
      pushCorner(f.verts[3], f.uvsRaw[3], f.pidx);
    }
  }

  return { positions, uvs, triplets };
}

function computeWheelTargets(bodyTriplets, wheelsRaw) {
  if (!wheelsRaw || wheelsRaw.length < 4) return null;

  let min_y = 0, max_y = 0, min_x = 0, max_x = 0;
  if (bodyTriplets.length) {
    const xs = bodyTriplets.map((p) => p[0]);
    const ys = bodyTriplets.map((p) => p[1]);
    min_x = Math.min(...xs); max_x = Math.max(...xs);
    min_y = Math.min(...ys); max_y = Math.max(...ys);
  }

  const body_h = Math.max(1e-6, max_y - min_y);
  const body_w = Math.max(1e-6, max_x - min_x);

  // Increased base radius from 0.16 -> 0.22 and width from 0.065 -> 0.085
  const radius = Math.max(0.08, Math.min(0.35, body_h * 0.22));
  const width = Math.max(0.05, Math.min(0.18, body_w * 0.075));

  // Vertical shift to move wheels up into arches (+Y is up in World Space)
  const yOffset = body_h * 0.18; 

  const targets = [];
  for (let i = 0; i < 4; i++) {
    const raw = wheelsRaw[i];
    const isFront = i < 2;

    targets.push({
      cx: raw.x,
      cy: -raw.y + yOffset, // Lift wheels higher into the arches
      cz: raw.z,
      isFront
    });
  }

  return {
    targets,
    radius_f: radius,
    radius_r: radius * 1.02,
    width_f: width,
    width_r: width * 1.04,
  };
}

function buildWheelGeometry(cx, cy, cz, radius, width, segments = 20) {
  const positions = [];
  const colors = [];
  const indices = [];
  if (radius <= 1e-6) return { positions, colors, indices };

  const half = Math.max(radius * 0.18, Math.abs(width) * 0.5);
  const tyreInner = radius * 0.72;
  const rimInner = radius * 0.28;
  const tyreCol = [0.06, 0.06, 0.07];
  const sidewallCol = [0.1, 0.1, 0.11];
  const rimCol = [0.55, 0.55, 0.58];
  const hubCol = [0.22, 0.22, 0.24];

  const add = (px, py, pz, col) => {
    positions.push(px, py, pz);
    colors.push(col[0], col[1], col[2]);
    return positions.length / 3 - 1;
  };

  const t_ol = [], t_or = [], r_ol = [], r_or = [], h_ol = [], h_or = [];

  for (let i = 0; i < segments; i++) {
    const a = (2.0 * Math.PI * i) / segments;
    const sy = Math.sin(a), cz_ = Math.cos(a);

    const y = cy + radius * sy, z = cz + radius * cz_;
    t_ol.push(add(cx - half, y, z, tyreCol));
    t_or.push(add(cx + half, y, z, tyreCol));

    const yi = cy + tyreInner * sy, zi = cz + tyreInner * cz_;
    r_ol.push(add(cx - half * 0.85, yi, zi, sidewallCol));
    r_or.push(add(cx + half * 0.85, yi, zi, sidewallCol));

    const yh = cy + rimInner * sy, zh = cz + rimInner * cz_;
    h_ol.push(add(cx - half * 0.35, yh, zh, rimCol));
    h_or.push(add(cx + half * 0.35, yh, zh, rimCol));
  }

  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(t_ol[i], t_or[i], t_or[j], t_ol[i], t_or[j], t_ol[j]);
    indices.push(t_ol[i], t_ol[j], r_ol[j], t_ol[i], r_ol[j], r_ol[i]);
    indices.push(t_or[i], r_or[i], r_or[j], t_or[i], r_or[j], t_or[j]);
    indices.push(r_ol[i], r_ol[j], h_ol[j], r_ol[i], h_ol[j], h_ol[i]);
    indices.push(r_or[i], h_or[i], h_or[j], r_or[i], h_or[j], r_or[j]);
  }

  const hub_l = add(cx - half * 0.15, cy, cz, hubCol);
  const hub_r = add(cx + half * 0.15, cy, cz, hubCol);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(hub_l, h_ol[j], h_ol[i]);
    indices.push(hub_r, h_or[i], h_or[j]);
  }

  return { positions, colors, indices };
}

function buildAllWheelArrays(bodyTriplets, wheelsRaw) {
  const result = computeWheelTargets(bodyTriplets, wheelsRaw);
  const positions = [];
  const colors = [];
  const indices = [];
  if (!result) return { positions, colors, indices };

  for (const t of result.targets) {
    const r = t.isFront ? result.radius_f : result.radius_r;
    const w = t.isFront ? result.width_f : result.width_r;
    const wheel = buildWheelGeometry(t.cx, t.cy, t.cz, r, w);
    const base = positions.length / 3;
    positions.push(...wheel.positions);
    colors.push(...wheel.colors);
    for (const idx of wheel.indices) indices.push(base + idx);
  }
  return { positions, colors, indices };
}

// ---------------------------------------------------------------------------
// GT-CTEX → vertical palette atlas
// ---------------------------------------------------------------------------
function generateTexAtlas(buffer, paletteSet, usedKeys) {
  const IMAGE_OFF = 0x60;
  const IMAGE_SIZE = (256 * 256) / 2;
  const PAL_OFF = 0x8060;
  const PAL_STRIDE = 512;
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
  const keyToRow = new Map(usedKeys.map((k, i) => [k & 0x0f, i]));
  const nRows = usedKeys.length;

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
      off = 0x20;
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

// ---------------------------------------------------------------------------
// Palette editor UI
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