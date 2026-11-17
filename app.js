// 3D viewer of the chata. The model (chata.glb) is exported from Blender by export_glb.py;
// every object carries `patro` in its glTF extras: sklep | prizemi | podkrovi | strecha | teren.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyTexture, boxUV } from './textures.js';

const ORDER = ['sklep', 'prizemi', 'podkrovi', 'strecha'];          // bottom to top
const INFO = {
  '': ['Celý dům', 'Klikni na patro v modelu nebo v nabídce.'],
  podkrovi: ['Podkroví', 'dvě ložnice, koupelna a WC'],
  prizemi: ['Přízemí', 'kuchyň s ostrůvkem, jídelna a obývací část, vstup na terasu'],
  sklep: ['Sklep', 'garáž, koupelna se sprchou, WC a technické zázemí'],
};
const LIFT = 7, LIFT_STEP = 2.5;        // metres the hidden levels rise while they fade out
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const canvas = document.getElementById('scene');
const statusEl = document.getElementById('status');
const captionEl = document.getElementById('caption');
const buttons = [...document.querySelectorAll('#floors button')];

// ---------------------------------------------------------------- renderer, scene, light
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = skyTexture();
scene.fog = new THREE.Fog(0xd5e3ea, 70, 190);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;

scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8d9a73, 0.85));
const sun = new THREE.DirectionalLight(0xfff1dc, 3.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const camera = new THREE.PerspectiveCamera(38, 1, 0.3, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 5;
controls.maxDistance = 70;

function skyTexture() {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d'); const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#8fb9dc'); grad.addColorStop(0.55, '#cfe0ea'); grad.addColorStop(1, '#e9eee6');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- model
const groups = {};                       // patro -> { nodes, mats, lift, fade, box }
for (const p of [...ORDER, 'teren']) groups[p] = { nodes: [], mats: new Set(), lift: 0, fade: 1, glow: 0, box: new THREE.Box3() };
const houseBox = new THREE.Box3();
let selected = '';                       // '' = whole house
let hovered = '';
let camGoal = null;                      // { pos, target } while the camera is travelling

new GLTFLoader().load('chata.glb', (gltf) => {
  const matCache = new Map();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh) boxUV(o); });     // the model has no UVs; project them in metres
  for (const node of gltf.scene.children) {
    const patro = node.userData.patro;
    if (!groups[patro]) continue;
    const grp = groups[patro];
    node.userData.baseY = node.position.y;
    grp.nodes.push(node);
    node.traverse((o) => {
      if (!o.isMesh) return;
      // one material instance per level, so each level can fade on its own
      const key = o.material.uuid + '|' + patro;
      if (!matCache.has(key)) matCache.set(key, prepareMaterial(o.material));
      o.material = matCache.get(key);
      grp.mats.add(o.material);
      const glass = o.material.userData.glass;
      o.castShadow = !glass; o.receiveShadow = !glass;
    });
  }
  scene.add(gltf.scene);
  scene.updateMatrixWorld(true);
  for (const p of ORDER) for (const n of groups[p].nodes) { groups[p].box.expandByObject(n); houseBox.expandByObject(n); }

  // sun from the south-west, over the terrace; shadow frustum fitted to the house
  const c = houseBox.getCenter(new THREE.Vector3());
  sun.target.position.copy(c);
  sun.position.copy(c).add(new THREE.Vector3(-0.55, 0.95, 0.7).multiplyScalar(45));
  const s = sun.shadow.camera; s.left = s.bottom = -22; s.right = s.top = 22; s.near = 5; s.far = 110; s.updateProjectionMatrix();

  const home = viewFor('');
  camera.position.copy(home.pos); controls.target.copy(home.target); controls.update();
  select('', false);
  statusEl.classList.add('done');
}, undefined, (err) => {
  console.error(err);
  if (location.protocol !== 'file:') statusEl.querySelector('p').textContent = 'Model se nepodařilo načíst (chata.glb).';
});

function prepareMaterial(src) {
  const glass = /sklo/i.test(src.name);
  let m;
  if (glass) {
    // real transmission is costly and does not fade; a thin tinted pane reads the same at this scale
    m = new THREE.MeshStandardMaterial({ name: src.name, color: 0xbfd8e2, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false });
  } else {
    m = src.clone();
    applyTexture(m);
  }
  m.userData = { glass, baseOpacity: m.opacity, baseTransparent: m.transparent };
  return m;
}

// ---------------------------------------------------------------- floor selection
function select(patro, animateCamera = true) {
  selected = patro;
  const level = ORDER.indexOf(patro);                 // -1 = whole house
  ORDER.forEach((p, i) => {
    const hidden = level >= 0 && i > level;
    groups[p].goalFade = hidden ? 0 : 1;
    groups[p].goalLift = hidden ? LIFT + (i - level - 1) * LIFT_STEP : 0;
  });
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.floor === patro));
  const [title, text] = INFO[patro];
  captionEl.innerHTML = `<b>${title}</b> <span>· ${text}</span>`;
  if (animateCamera) camGoal = viewFor(patro);
  if (reduceMotion) settle();
}

function viewFor(patro) {
  // keep the direction the visitor is looking from, change height and distance
  const box = patro ? groups[patro].box : houseBox;
  const target = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  let azimuth = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  if (!camera.userData.placed) { azimuth = THREE.MathUtils.degToRad(-12); camera.userData.placed = true; }
  const polar = THREE.MathUtils.degToRad(patro ? 34 : 62);
  const fit = Math.max(size.x, size.z) * (patro ? 1.25 : 1.5);
  const aspect = Math.min(camera.aspect, 1.6);
  const dist = fit / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.min(1, aspect)) + size.y * 0.5;
  if (patro) target.y = box.min.y + 0.6;
  const pos = new THREE.Vector3().setFromSphericalCoords(dist, polar, azimuth).add(target);
  return { pos, target };
}

function settle() {
  for (const p of ORDER) { groups[p].fade = groups[p].goalFade; groups[p].lift = groups[p].goalLift; }
  if (camGoal) { camera.position.copy(camGoal.pos); controls.target.copy(camGoal.target); camGoal = null; }
}

for (const b of buttons) {
  b.addEventListener('click', () => select(b.dataset.floor));
  b.addEventListener('pointerenter', () => setHover(b.dataset.floor));
  b.addEventListener('pointerleave', () => setHover(''));
}
addEventListener('keydown', (e) => { if (e.key === 'Escape') select(''); });

// ---------------------------------------------------------------- picking in the model
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down = null;

function pick(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const targets = [];
  for (const p of ORDER) if (groups[p].fade > 0.5) targets.push(...groups[p].nodes);
  targets.push(...groups.teren.nodes);                 // the ground hides what is behind it
  const hit = raycaster.intersectObjects(targets, true)[0];
  if (!hit) return '';
  let o = hit.object;
  while (o && !o.userData.patro) o = o.parent;
  const patro = o ? o.userData.patro : '';
  if (patro === 'teren') return '';
  return patro === 'strecha' ? 'podkrovi' : patro;     // the roof belongs to the attic
}

function setHover(patro) {
  hovered = patro;
  canvas.classList.toggle('pointing', !!patro);
  for (const b of buttons) b.classList.toggle('hover', !!patro && b.dataset.floor === patro);
}

canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; canvas.classList.add('grabbing'); });
canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && !e.buttons) setHover(pick(e)); });
canvas.addEventListener('pointerleave', () => setHover(''));
addEventListener('pointerup', (e) => {
  canvas.classList.remove('grabbing');
  if (!down || e.target !== canvas) { down = null; return; }
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = performance.now() - down.t < 500;
  down = null;
  if (moved > 6 || !quick) return;                     // it was a drag, not a click
  const patro = pick(e);
  if (patro) select(patro === selected ? '' : patro);
});
controls.addEventListener('start', () => { camGoal = null; });   // the visitor takes over the camera

window.chata = { groups, camera, controls, scene, select, houseBox };   // handy in the browser console

// ---------------------------------------------------------------- frame loop
const clock = new THREE.Clock();
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const k = 1 - Math.exp(-dt * 4.5);
  for (const p of ORDER) {
    const g = groups[p];
    if (g.goalFade === undefined) continue;
    // fade out a little faster than the lift, fade in a little later than the drop
    g.lift += (g.goalLift - g.lift) * k;
    g.fade += (g.goalFade - g.fade) * (1 - Math.exp(-dt * (g.goalFade < g.fade ? 6 : 3.5)));
    if (Math.abs(g.goalLift - g.lift) < 0.002) g.lift = g.goalLift;
    if (Math.abs(g.goalFade - g.fade) < 0.004) g.fade = g.goalFade;
    const show = g.fade > 0.01;
    for (const n of g.nodes) { n.visible = show; n.position.y = n.userData.baseY + g.lift; }
    const lit = hovered && (p === hovered || (hovered === 'podkrovi' && p === 'strecha')) && hovered !== selected;
    g.glow += ((lit ? 1 : 0) - g.glow) * (1 - Math.exp(-dt * 12));
    for (const m of g.mats) {
      const faded = g.fade < 0.995;
      m.opacity = m.userData.baseOpacity * g.fade;
      m.transparent = m.userData.baseTransparent || faded;
      m.depthWrite = !m.userData.glass;
      if (m.emissive) m.emissive.setRGB(0.05, 0.07, 0.055).multiplyScalar(g.glow);
    }
  }
  if (camGoal) {
    camera.position.lerp(camGoal.pos, k); controls.target.lerp(camGoal.target, k);
    if (camera.position.distanceTo(camGoal.pos) < 0.02) camGoal = null;
  }
  controls.update();
  renderer.render(scene, camera);
});
