// Procedural textures for the viewer, drawn on canvases at start-up (no image files to download).
// The model has no UV maps, so boxUV() projects every face in building-local metres:
// u/v are real distances, and a texture's `size` below is the edge of one tile in metres.
import * as THREE from 'three';

// ---------------------------------------------------------------- tileable value noise
function makeNoise(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const N = 64, grid = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) grid[i] = rnd();
  const smooth = (t) => t * t * (3 - 2 * t);
  // period = how many lattice cells fit into one tile (must divide evenly so the tile repeats)
  const wrap = (i, period) => (((i % period) + period) % period) % N;
  const value = (x, y, px, py) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = smooth(x - xi), fy = smooth(y - yi);
    const g = (ix, iy) => grid[wrap(iy, py) * N + wrap(ix, px)];
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  // fractal noise over the unit tile, 0..1
  const fbm = (u, v, base, octaves, sx = 1, sy = 1) => {
    let sum = 0, amp = 1, norm = 0, p = base;
    for (let o = 0; o < octaves; o++) {
      sum += value(u * p * sx, v * p * sy, p * sx, p * sy) * amp; norm += amp; amp *= 0.5; p *= 2;
    }
    return sum / norm;
  };
  return { fbm, rnd };
}

function canvasTexture(px, shade) {
  // shade(u, v) -> [r, g, b] multipliers 0..1 (the material colour multiplies the map)
  const c = document.createElement('canvas'); c.width = c.height = px;
  const ctx = c.getContext('2d'), img = ctx.createImageData(px, px), d = img.data;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const rgb = shade((x + 0.5) / px, (y + 0.5) / px), i = (y * px + x) * 4;
    d[i] = Math.max(0, Math.min(255, rgb[0] * 255)); d[i + 1] = Math.max(0, Math.min(255, rgb[1] * 255));
    d[i + 2] = Math.max(0, Math.min(255, rgb[2] * 255)); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const grey = (k) => [k, k, k];
const line = (x, period, width) => { const f = ((x % period) + period) % period; return f < width || f > period - width ? 1 : 0; };

// ---------------------------------------------------------------- texture recipes
// each returns { map, size (metres per tile), bump (bumpScale), tint (colour multiplier) }
const RECIPES = {
  plaster() {
    const n = makeNoise(11);
    return { size: 1.6, bump: 0.6, tint: 1.08, map: canvasTexture(512, (u, v) =>
      grey(0.93 + 0.04 * n.fbm(u, v, 4, 2) + 0.07 * (n.fbm(u, v, 64, 2) - 0.5))) };
  },
  paint() {
    const n = makeNoise(12);
    return { size: 1.2, bump: 0.2, tint: 1.03, map: canvasTexture(256, (u, v) => grey(0.94 + 0.05 * (n.fbm(u, v, 32, 2) - 0.5))) };
  },
  concrete() {
    const n = makeNoise(13);
    return { size: 3, bump: 0.5, tint: 1.1, map: canvasTexture(512, (u, v) => {
      const cloud = n.fbm(u, v, 4, 4), speck = n.fbm(u, v, 64, 1);
      return grey(0.78 + 0.18 * cloud + (speck > 0.82 ? -0.10 : 0) + 0.05 * (n.fbm(u, v, 32, 2) - 0.5));
    }) };
  },
  roof() {
    // standing-seam sheet: seams every 0.5 m (two per 1 m tile), running along u
    const n = makeNoise(14);
    return { size: 1, bump: 1.6, tint: 1.7, map: canvasTexture(512, (u, v) => {
      const seam = line(v, 0.5, 0.022), edge = line(v, 0.5, 0.05) - seam;
      return grey(0.80 + 0.10 * n.fbm(u, v, 4, 3, 1, 8) + 0.20 * seam - 0.22 * edge);
    }) };
  },
  wood(seed = 15, contrast = 0.22) {
    // straight grain along v
    const n = makeNoise(seed);
    return { size: 1.2, bump: 0.5, tint: 1.12, map: canvasTexture(512, (u, v) => {
      const g = n.fbm(u, v, 4, 4, 16, 1), ring = Math.sin((u * 60 + n.fbm(u, v, 4, 2, 4, 1) * 14)) * 0.5 + 0.5;
      const k = 0.84 + contrast * (g - 0.5) + 0.06 * (ring - 0.5);
      return [k, k * 0.985, k * 0.96];
    }) };
  },
  decking() {
    // four 145 mm boards across u, running along v, open joints
    const n = makeNoise(16);
    return { size: 0.58, vsize: 2.4, bump: 1.4, tint: 1.15, map: canvasTexture(512, (u, v) => {
      const board = Math.floor(u * 4), joint = line(u, 0.25, 0.012);
      const tone = 0.82 + 0.16 * (n.fbm(board * 0.37 + 0.1, 0.5, 8, 1) - 0.5);
      const g = n.fbm(u + board * 0.31, v, 4, 4, 16, 1);
      const k = joint ? 0.28 : tone + 0.20 * (g - 0.5);
      return [k, k * 0.98, k * 0.95];
    }) };
  },
  oakFloor() {
    // four 190 mm boards across u, staggered end joints along v
    const n = makeNoise(17);
    return { size: 0.76, vsize: 2.4, bump: 0.5, tint: 1.12, map: canvasTexture(512, (u, v) => {
      const board = Math.floor(u * 4), joint = line(u, 0.25, 0.004);
      const vv = (v + board * 0.37) % 1, endJoint = line(vv, 0.5, 0.002), plank = board * 2 + Math.floor(vv * 2);
      const tone = 0.88 + 0.08 * (n.fbm(plank * 0.23 + 0.05, 0.3, 16, 1) - 0.5);
      const g = n.fbm(u + plank * 0.19, v, 4, 4, 14, 1);
      const k = joint || endJoint ? 0.62 : tone + 0.10 * (g - 0.5);
      return [k, k * 0.98, k * 0.94];
    }) };
  },
  garage() {
    // sectional door: joints every 0.3 m in height (two per 0.6 m tile)
    return { size: 0.6, bump: 1.5, tint: 1.15, map: canvasTexture(256, (u, v) => {
      const groove = line(v, 0.5, 0.03), rib = line(v, 0.125, 0.008);
      return grey(0.88 - 0.45 * groove - 0.10 * rib * (1 - groove));
    }) };
  },
  grass() {
    const n = makeNoise(18);
    return { size: 9, bump: 0, tint: 1.12, map: canvasTexture(1024, (u, v) => {
      const patch = n.fbm(u, v, 4, 4), fine = n.fbm(u, v, 64, 2), dry = n.fbm(u + 0.37, v + 0.11, 8, 3);
      const k = 0.70 + 0.20 * patch + 0.14 * (fine - 0.5);
      return [k * (0.92 + 0.16 * dry), k, k * (0.80 + 0.14 * patch)];
    }) };
  },
  fabric() {
    const n = makeNoise(19);
    return { size: 0.25, bump: 0.5, tint: 1.08, map: canvasTexture(256, (u, v) => {
      const weave = (Math.sin(u * Math.PI * 80) * Math.sin(v * Math.PI * 80)) * 0.5 + 0.5;
      return grey(0.84 + 0.10 * weave + 0.08 * (n.fbm(u, v, 16, 2) - 0.5));
    }) };
  },
};

// glTF material name -> recipe
const RULES = [
  [/garazova vrata/i, 'garage'], [/terasa \| prkna/i, 'decking'], [/podlaha/i, 'oakFloor'],
  [/strecha/i, 'roof'], [/omitka/i, 'plaster'], [/interierove/i, 'paint'], [/beton/i, 'concrete'],
  [/teren/i, 'grass'], [/drevo|dvere|dverni/i, 'wood'],
  [/calouneni|matrace|prikryvka|polstar/i, 'fabric'],
];
const cache = new Map();

export function textureFor(name) {
  const rule = RULES.find(([re]) => re.test(name));
  if (!rule) return null;
  if (!cache.has(rule[1])) cache.set(rule[1], RECIPES[rule[1]]());
  return cache.get(rule[1]);
}

/** Give a material its texture (shared canvases, separate repeat per material is not needed). */
export function applyTexture(material) {
  const t = textureFor(material.name);
  if (!t) return;
  t.map.repeat.set(1 / t.size, 1 / (t.vsize || t.size));
  material.map = t.map;
  if (t.bump) { material.bumpMap = t.map; material.bumpScale = t.bump; }
  material.color.multiplyScalar(t.tint);
  material.needsUpdate = true;
}

// ---------------------------------------------------------------- box-projected UVs in building-local metres
const S = Math.SQRT1_2;
/** The house is turned 45 degrees in plan; local x runs across it, local y along it, local z up. */
function toLocal(v, out) { out.set((v.x - v.z) * S, (-v.z - v.x) * S, v.y); return out; }

export function boxUV(mesh) {
  let geo = mesh.geometry;
  if (geo.index) geo = mesh.geometry = geo.toNonIndexed();
  const pos = geo.attributes.position, uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const la = new THREE.Vector3(), lb = new THREE.Vector3(), lc = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld);
    toLocal(a, la); toLocal(b, lb); toLocal(c, lc);
    n.crossVectors(e1.subVectors(lb, la), e2.subVectors(lc, la));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    [la, lb, lc].forEach((p, k) => {
      let u, v;
      if (az >= ax && az >= ay) { u = p.x; v = p.y; }          // floors, roofs, terrain: plan projection
      else if (ax >= ay) { u = p.y; v = p.z; }                 // long walls
      else { u = p.x; v = p.z; }                               // gable walls
      uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
    });
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
