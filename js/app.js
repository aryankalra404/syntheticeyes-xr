// The bust page: scene, materials, lights, the rig, the gaze and the XR session.
//
// Frames. "Bust space" is the glTF frame of head.glb: metres, +X image-right (the subject's
// left), +Y up, the face looks along +Z. The bust group (head + plinth) carries that frame into
// the world; everything the rig and the gaze do is computed in bust space.
//
// URL parameters (all optional):
//   view=face|eyes|eye|eyeL     put the camera where tools/render_stills.py and rig_strips.py put
//                          theirs (cam_test_face, cam_test_eye) or at 0.7 m (bust)
//   size=800               render into a fixed square canvas of this many CSS pixels
//   shot=1                 hide the text overlays (for screenshots)
//   pose=1                 debug pose, time frozen; channels from gy gp gd (gaze yaw, pitch in
//                          deg, distance in m, default 1.6 as in tools/rig_strips.py), hy hp hr
//                          (head), blink (or blinkL / blinkR), brow (or browL / browR), widen,
//                          squint, pupil
//   seed=0                 the gaze's seed (default 0)
//   follow=0               start with the mouse not followed (the controls can turn it on)
//   yaw, pitch, dist       laptop wearer's start: deg round the head, deg up, metres
//
// Without a headset the camera is the wearer: the mouse moves it on an arc round the head
// (±50 deg sideways, ±20 up and down), the wheel changes the distance (0.3 to 1.5 m), a touch
// drag does the same on a phone. Taking the mouse off the page is walking away.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { XRButton } from 'three/addons/webxr/XRButton.js';
import { Rig, bonesLocal } from './rig.js';
import { createGaze, step as gazeStep } from './gaze.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const ASSETS = './assets/';
const status = (t) => { const s = document.getElementById('status'); if (s) s.textContent = t; };

// ---- renderer, scene, camera ---------------------------------------------------------------

const stage = document.getElementById('stage');
const fixed = Q.has('size') ? Math.round(num('size', 800)) : 0;
if (fixed) stage.classList.add('fixed');
if (Q.get('shot') === '1') document.body.classList.add('shot');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true,
                                           preserveDrawingBuffer: Q.get('shot') === '1' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const TONES = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping };
// ACES, not AgX: without subsurface scattering AgX left the skin pale and grey next to the
// Cycles still; ACES keeps its warmth and contrast closer.
renderer.toneMapping = TONES[Q.get('tone')] ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 0.75);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const DARK = new THREE.Color(0x0d0d0f);
scene.background = DARK;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = num('env', 0.1);

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
scene.add(camera);

// The bust group: placed in the world by the laptop view or by the XR placement.
const bust = new THREE.Group();
bust.name = 'bust';
scene.add(bust);

// Key light from upper image-left and in front, as in the stills (Blender `key` area light at
// (-0.42, 0.73, 0.63) in bust space), aimed at the eyes. It lives in the bust group, so it
// keeps lighting the face the same way wherever the bust is placed.
const key = new THREE.DirectionalLight(0xfff4ea, num('key', 3.6));
key.position.set(-0.42, 0.73, 0.63);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -0.16; key.shadow.camera.right = 0.16;
key.shadow.camera.top = 0.16; key.shadow.camera.bottom = -0.16;
key.shadow.camera.near = 0.3; key.shadow.camera.far = 1.6;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.0015;
key.shadow.radius = 3;
bust.add(key);
bust.add(key.target);
// Rim from behind image-right (Blender `rim` at (0.44, 0.51, -0.73)). Off by default: its
// specular drew a glossy streak down the shadow side of the nose, and in passthrough the room
// is the backdrop anyway. ?rimlight=1 turns it on.
const rim = new THREE.DirectionalLight(0xffffff, num('rimlight', 0));
rim.position.set(0.44, 0.51, -0.73);
bust.add(rim);
bust.add(rim.target);

function resize() {
  const w = fixed || window.innerWidth;
  const h = fixed || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  setView();
}
window.addEventListener('resize', resize);

// ---- assets --------------------------------------------------------------------------------

function loadTexture(name, srgb) {
  return new Promise((ok, fail) => {
    new THREE.TextureLoader().load(ASSETS + name, (t) => {
      t.flipY = false;                       // glTF UVs: v already flipped by the exporter
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      ok(t);
    }, undefined, fail);
  });
}

async function loadAll() {
  const [gltf, rig, albedo, normal, rough, eyeL, eyeR] = await Promise.all([
    new GLTFLoader().loadAsync(ASSETS + 'head.glb'),
    fetch(ASSETS + 'rig.json').then((r) => r.json()),
    loadTexture('skin_albedo.jpg', true),
    loadTexture('skin_normal.png', false),
    loadTexture('skin_rough.jpg', false),
    loadTexture('eye_L.jpg', true),
    loadTexture('eye_R.jpg', true),
  ]);
  return { gltf, rig, tex: { albedo, normal, rough, eyeL, eyeR } };
}

// ---- materials -----------------------------------------------------------------------------

function makeMaterials(tex) {
  const skin = new THREE.MeshPhysicalMaterial({
    name: 'skin', map: tex.albedo, normalMap: tex.normal,
    normalScale: new THREE.Vector2(num('normal', 1.2), num('normal', 1.2)),
    roughnessMap: tex.rough, roughness: num('rough', 1.0), metalness: 0,
    specularIntensity: num('spec', 0.45), sheen: 0.08, sheenRoughness: 0.4,
    sheenColor: new THREE.Color(0.9, 0.75, 0.7),
  });
  const eye = (map, name) => new THREE.MeshStandardMaterial({ name, map, roughness: 0.55, metalness: 0 });
  // The cornea: a thin clear shell that adds only its reflections (black base colour, additive
  // blending), so the iris shows through untouched and the key light and the environment give
  // the catch light. No transmission, no refraction: both cost too much in a headset.
  const cornea = (name) => new THREE.MeshPhysicalMaterial({
    name, color: 0x000000, roughness: 0.03, metalness: 0, specularIntensity: 1.0,
    ior: 1.376, envMapIntensity: 2.5, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return {
    skin,
    'eye_interior.L': eye(tex.eyeL, 'eye_interior.L'),
    'eye_interior.R': eye(tex.eyeR, 'eye_interior.R'),
    'cornea.L': cornea('cornea.L'),
    'cornea.R': cornea('cornea.R'),
    teeth: new THREE.MeshStandardMaterial({ name: 'teeth', color: 0xd8d0c0, roughness: 0.4 }),
    // lashes: ribbons from the scene's lash carrier. Opaque black ribbons read as wedges of
    // mascara close up, so an alpha map over the ribbon's UV (u across, v root to tip) keeps
    // only a soft core and lets the outer half fade to nothing; dark brown, no highlight.
    lashes: new THREE.MeshStandardMaterial({ name: 'lashes', color: new THREE.Color(0.045, 0.03, 0.02),
                                             roughness: 1.0, metalness: 0.0, envMapIntensity: 0.0,
                                             alphaMap: lashAlpha(), transparent: true, depthWrite: false,
                                             side: THREE.DoubleSide }),
    // the tear meniscus: like the cornea, only its glint (black, additive, mirror-smooth)
    tear_line: new THREE.MeshPhysicalMaterial({ name: 'tear_line', color: 0x000000, roughness: 0.05,
                                                specularIntensity: 1.0, envMapIntensity: 0.8,
                                                transparent: true, blending: THREE.AdditiveBlending,
                                                depthWrite: false, side: THREE.DoubleSide }),
    tongue: new THREE.MeshStandardMaterial({ name: 'tongue', color: 0x9a4a48, roughness: 0.5 }),
  };
}

// Alpha over a lash ribbon: a soft core across its width, solid from the root, fading out over
// the outer half. glTF flips v, so the root is at v = 1 in texture space.
function lashAlpha() {
  const w = 16, h = 64, data = new Uint8Array(w * h * 4);
  const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
  for (let y = 0; y < h; y++) {
    const len = 1 - (y + 0.5) / h;                       // 0 at the root, 1 at the tip
    const along = smooth(0.0, 0.06, len) * (1 - smooth(0.4, 1.0, len));
    for (let x = 0; x < w; x++) {
      const across = Math.sin(Math.PI * (x + 0.5) / w) ** 2;
      const a = Math.round(255 * along * across);
      data.set([a, a, a, 255], (y * w + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// ---- the bust ------------------------------------------------------------------------------

const H = { meshes: [], rig: null, root: null, eyeHeight: 0.304, eyeZ: 0.0976 };

function buildBust({ gltf, rig, tex }) {
  const mats = makeMaterials(tex);
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const name = o.material.name;
    o.material = mats[name] || o.material;
    o.castShadow = name === 'skin';            // lash shadows at this map size only flicker
    o.receiveShadow = true;
    o.frustumCulled = false;                // skinned bounds do not follow the bones
    if (name.startsWith('cornea') || name === 'tear_line') o.renderOrder = 2;
    H.meshes.push(o);
  });
  bust.add(root);
  H.root = root;
  H.rig = rig;
  H.eyeHeight = rig.eye_mid[1];
  H.eyeZ = rig.eye_mid[2];

  // Plinth: a plain dark cylinder whose top sits just inside the neck cut, so the cut never
  // shows and the head reads as a bust standing on something.
  const box = new THREE.Box3();
  const neck = [];
  for (const m of H.meshes) {
    if (m.material.name !== 'skin') continue;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(p, i));
  }
  for (const m of H.meshes) {
    if (m.material.name !== 'skin') continue;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < box.min.y + 0.03) neck.push([p.getX(i), p.getY(i), p.getZ(i)]);
    }
  }
  let cx = 0, cz = 0, r = 0, topY = -Infinity;
  for (const [x, , z] of neck) { cx += x; cz += z; }
  cx /= neck.length; cz /= neck.length;
  for (const [x, y, z] of neck) { r = Math.max(r, Math.hypot(x - cx, z - cz)); topY = Math.max(topY, y); }
  const height = num('plinth', 0.22);
  const top = box.min.y + 0.012;
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 1.02, r * 1.12, height, 64, 1, false),
    new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.6, metalness: 0.0 }));
  plinth.position.set(cx, top - height / 2, cz);
  plinth.receiveShadow = true;
  plinth.name = 'plinth';
  bust.add(plinth);
  H.plinth = { radius: r, top, bottom: top - height, cx, cz, cutTop: topY };
  key.target.position.set(0, H.eyeHeight, H.eyeZ);
  rim.target.position.set(0, H.eyeHeight, 0);
  setupRig(rig);
}

// ---- the rig -------------------------------------------------------------------------------

// Bone rest rotations in bust space, read from the loaded skeleton once, before any posing;
// rig.js bonesLocal() turns the rig's bust-space deltas into local quaternions from them.
function setupRig(rigJson) {
  H.rigMaths = new Rig(rigJson);
  H.root.updateMatrixWorld(true);
  const rootInv = new THREE.Quaternion();
  H.root.getWorldQuaternion(rootInv).invert();
  const want = { neck: 'neck', head: 'head', 'eye.L': 'eye.L', 'eye.R': 'eye.R' };
  H.bones = {};
  H.root.traverse((o) => {
    if (!o.isBone) return;
    for (const [n, gltfName] of Object.entries(want)) {
      if (o.name === THREE.PropertyBinding.sanitizeNodeName(gltfName)) H.bones[n] = o;
    }
  });
  const q = new THREE.Quaternion();
  const asArr = (x) => [x.x, x.y, x.z, x.w];
  H.restWorld = {};
  for (const [n, b] of Object.entries(H.bones)) {
    H.restWorld[n] = asArr(rootInv.clone().multiply(b.getWorldQuaternion(q)));
  }
  H.restWorld.root = asArr(rootInv.clone().multiply(H.bones.neck.parent.getWorldQuaternion(q)));
  H.morph = H.meshes.map((m) => ({ m, d: m.morphTargetDictionary }));
  applyChannels({});
  H.bones.head.updateWorldMatrix(true, false);
  H.headRestInv = H.bones.head.matrixWorld.clone().invert();
}

/** Pose the bust from channels (rig.js apply()); returns the rig state. */
function applyChannels(ch) {
  const st = H.rigMaths.apply(ch);
  const loc = bonesLocal(st.delta, H.restWorld);
  for (const [n, b] of Object.entries(H.bones)) b.quaternion.fromArray(loc[n]);
  for (const { m, d } of H.morph) {
    for (const [k, v] of Object.entries(st.weights)) {
      const i = d[k];
      if (i !== undefined) m.morphTargetInfluences[i] = v;
    }
  }
  H.state = st;
  return st;
}

function debugChannels() {
  const blink = num('blink', 0), brow = num('brow', 0);
  return {
    gaze_yaw: num('gy', 0), gaze_pitch: num('gp', 0), gaze_dist: num('gd', 1.6),
    head_yaw: num('hy', 0), head_pitch: num('hp', 0), head_roll: num('hr', 0),
    blink_L: num('blinkL', blink), blink_R: num('blinkR', blink),
    brow_L: num('browL', brow), brow_R: num('browR', brow),
    widen: num('widen', 0), squint: num('squint', 0), pupil: num('pupil', 0),
  };
}

// ---- views ---------------------------------------------------------------------------------

// Still cameras from scene.blend, converted to bust space: (x, y, z) -> (x, z, -y).
const VIEWS = {
  face: { pos: [-0.0001, 0.2662, 0.6676], dir: [0, 0, -1], lens: 126 },   // cam_test_face
  eyes: { pos: [-0.0001, 0.3042, 0.4976], dir: [0, 0, -1], lens: 105 },   // cam_eyes (rig_strips.py)
  eyeL: { pos: [0.0302, 0.3041, 0.2976], dir: [0, 0, -1], lens: 105 },    // the left eye, 20 cm, frontal
  eye: { pos: [-0.0305, 0.3197, 0.2466], dir: [0.405, -0.105, -0.909], lens: 100 }, // cam_test_eye
  video: { pos: [-0.0001, 0.2642, 0.6676], dir: [0, 0, -1], lens: 112 },  // cam_video
};
let FIXED_VIEW = VIEWS[Q.get('view')] || null;

// Controls for whoever opens the page: the view (the walk-round face, both eyes, one eye close
// up) and whether the mouse is followed. In the close-ups the camera stays put and the mouse
// moves where the eyes look instead; with following off the camera stands in front and the
// head simply keeps looking at you.
const ui = { follow: Q.get('follow') !== '0' };

// The laptop wearer: where the mouse puts the camera (goal) and where it is (smoothed, so the
// camera moves like a person stepping, not a cursor).
const D2R = Math.PI / 180;
const orbit = {
  goal: { yaw: num('yaw', 0), pitch: num('pitch', 0), dist: num('dist', 0.7) },
  now: { yaw: num('yaw', 0), pitch: num('pitch', 0), dist: num('dist', 0.7) },
  present: true,
};
const LIMITS = { yaw: 50, pitch: 20, near: 0.3, far: 1.5 };

function setView() {
  if (FIXED_VIEW) {
    const v = FIXED_VIEW;
    // Blender sensor fit is horizontal, 36 mm wide.
    const hfov = 2 * Math.atan(18 / v.lens);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect));
    camera.position.set(...v.pos);
    const d = new THREE.Vector3(...v.dir).normalize();
    camera.lookAt(camera.position.clone().add(d));
  } else {
    camera.fov = 40;
    placeOrbitCamera();
  }
  camera.updateProjectionMatrix();
}

function placeOrbitCamera() {
  const { yaw, pitch, dist } = orbit.now;
  const y = yaw * D2R, p = pitch * D2R;
  const c = new THREE.Vector3(0, H.eyeHeight, H.eyeZ);
  camera.position.set(c.x + dist * Math.sin(y) * Math.cos(p), c.y + dist * Math.sin(p),
                      c.z + dist * Math.cos(y) * Math.cos(p));
  camera.lookAt(c.x, c.y - 0.015, c.z);
}

function pointerToOrbit(x, y) {
  if (!ui.follow) return;
  const r = renderer.domElement.getBoundingClientRect();
  const u = THREE.MathUtils.clamp((x - r.left) / r.width, 0, 1);
  const v = THREE.MathUtils.clamp((y - r.top) / r.height, 0, 1);
  orbit.goal.yaw = (u * 2 - 1) * LIMITS.yaw;           // mouse right: the camera steps right
  orbit.goal.pitch = (1 - v * 2) * LIMITS.pitch;       // mouse up: the camera rises
}

function setupLaptopInput() {
  const el = renderer.domElement;
  let pinch = null;
  const touches = new Map();
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { orbit.present = true; pointerToOrbit(e.clientX, e.clientY); return; }
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 1) pointerToOrbit(e.clientX, e.clientY);
    else if (touches.size === 2 && pinch) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      orbit.goal.dist = THREE.MathUtils.clamp(pinch.dist * pinch.d0 / d, LIMITS.near, LIMITS.far);
    }
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 1) pointerToOrbit(e.clientX, e.clientY);
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]), dist: orbit.goal.dist };
    }
  });
  const up = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.goal.dist = THREE.MathUtils.clamp(orbit.goal.dist * Math.exp(e.deltaY * 0.0012), LIMITS.near, LIMITS.far);
  }, { passive: false });
  // taking the mouse off the page is walking away; coming back is being seen again
  document.documentElement.addEventListener('mouseleave', () => { if (ui.follow) orbit.present = false; });
  document.documentElement.addEventListener('mouseenter', () => { orbit.present = true; });
}

function smoothOrbit(dt) {
  const a = 1 - Math.exp(-dt / 0.25);
  for (const k of ['yaw', 'pitch', 'dist']) orbit.now[k] += (orbit.goal[k] - orbit.now[k]) * a;
}

function setFollow(on) {
  ui.follow = on;
  if (!on) {                                   // stand in front again and stay seen
    orbit.goal.yaw = 0; orbit.goal.pitch = 0;
    orbit.present = true;
  }
  const b = document.getElementById('follow');
  if (b) { b.setAttribute('aria-pressed', String(on)); b.querySelector('i').textContent = on ? 'on' : 'off'; }
  noteText();
}

function setViewName(name) {
  FIXED_VIEW = VIEWS[name] || null;
  for (const b of document.querySelectorAll('#controls [data-view]')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === (FIXED_VIEW ? name : '')));
  }
  setView();
  noteText();
}

function noteText() {
  const n = document.getElementById('follow-note');
  if (!n) return;
  n.textContent = !ui.follow ? 'The head keeps looking at you.'
    : FIXED_VIEW ? 'The eyes follow the mouse.'
    : 'Move the mouse to walk round the head, scroll to come closer.';
}

function setupControls() {
  for (const b of document.querySelectorAll('#controls [data-view]')) {
    b.addEventListener('click', () => setViewName(b.dataset.view));
  }
  const follow = document.getElementById('follow');
  if (follow) follow.addEventListener('click', () => setFollow(!ui.follow));
  setViewName(Q.get('view') || '');
  setFollow(ui.follow);
}

// Where the eyes look in a close-up: the camera, moved by the mouse up to about 35 deg
// sideways and 20 deg up or down, so the eye follows the pointer while the frame stays still.
const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
function steerViewer(viewer) {
  if (!ui.follow) return viewer;
  const mid = H.rig.eye_mid;
  _v.fromArray(viewer.pos).sub(_u.fromArray(mid));
  const d = _v.length();
  const tx = Math.tan(orbit.now.yaw / LIMITS.yaw * 35 * D2R) * d;
  const ty = Math.tan(orbit.now.pitch / LIMITS.pitch * 20 * D2R) * d;
  _r.fromArray(viewer.right).multiplyScalar(tx);
  _u.fromArray(viewer.up).multiplyScalar(ty);
  _v.fromArray(viewer.pos).add(_r).add(_u);
  viewer.pos = _v.toArray();
  return viewer;
}

// The close-up cameras ride with the head, like a head-mounted eye camera, so a head turn does
// not push the eye out of frame. The gaze target above is taken from the camera before it moves,
// so the eyes keep looking where the viewer is and only they move in the frame.
const CLOSEUP_HEAD = num('closeuphead', 0.35);
const _hw = new THREE.Matrix4(), _cm = new THREE.Matrix4();
function rideWithHead() {
  const head = H.bones && H.bones.head;
  if (!head || !H.headRestInv) return;
  head.updateWorldMatrix(true, false);
  _hw.multiplyMatrices(head.matrixWorld, H.headRestInv);      // head now, relative to rest
  _cm.multiplyMatrices(_hw, camera.matrixWorld);
  _cm.decompose(camera.position, camera.quaternion, camera.scale);
  camera.updateMatrixWorld(true);
}

// ---- XR ------------------------------------------------------------------------------------

const xrState = { place: false, ar: false, frames: 0 };

async function xrSupported() {
  if (!navigator.xr || !window.isSecureContext) return false;
  for (const mode of ['immersive-ar', 'immersive-vr']) {
    try { if (await navigator.xr.isSessionSupported(mode)) return true; } catch { /* next */ }
  }
  return false;
}

async function setupXR() {
  // Without a headset, say where to open the page instead of three.js's "XR NOT SUPPORTED".
  if (!(await xrSupported())) {
    const hint = document.getElementById('headset');
    if (hint) hint.hidden = false;
    return;
  }
  const button = XRButton.createButton(renderer, { requiredFeatures: ['local-floor'],
                                                   optionalFeatures: ['hand-tracking'] });
  document.body.appendChild(button);
  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    // passthrough when the session blends with the room; a dark room otherwise (immersive-vr)
    xrState.ar = session.environmentBlendMode !== undefined && session.environmentBlendMode !== 'opaque';
    scene.background = xrState.ar ? null : DARK;
    xrState.place = true;
    xrState.frames = 0;
    // the trigger or a pinch (any input's select) places the bust again
    session.addEventListener('select', () => { xrState.place = true; });
  });
  renderer.xr.addEventListener('sessionend', () => {
    scene.background = DARK;
    bust.position.set(0, 0, 0);
    bust.quaternion.identity();
    bust.updateMatrixWorld(true);
    setView();
  });
}

/** Stand the bust 0.7 m in front of the wearer, its eyes at their eye height, facing them. */
function placeBust(xrCam) {
  const pos = new THREE.Vector3(), q = new THREE.Quaternion();
  xrCam.getWorldPosition(pos);
  xrCam.getWorldQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const eyesAt = pos.clone().addScaledVector(fwd, 0.7);
  eyesAt.y = pos.y;
  // the bust faces +Z in its own space; turn it so +Z points back at the wearer
  const yaw = Math.atan2(-fwd.x, -fwd.z);
  bust.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const mid = new THREE.Vector3(...H.rig.eye_mid).applyQuaternion(bust.quaternion);
  bust.position.copy(eyesAt).sub(mid);
  bust.updateMatrixWorld(true);
}

// ---- the wearer, in bust space ---------------------------------------------------------------

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _bq = new THREE.Quaternion();
function viewerFrom(cam) {
  bust.updateMatrixWorld(true);
  cam.getWorldPosition(_p);
  cam.getWorldQuaternion(_q);
  bust.getWorldQuaternion(_bq).invert();
  const local = bust.worldToLocal(_p.clone());
  const toBust = _bq.clone().multiply(_q);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(toBust);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(toBust);
  return { pos: local.toArray(), right: right.toArray(), up: up.toArray() };
}

// ---- loop ----------------------------------------------------------------------------------

const POSE = Q.get('pose') === '1';
const timer = { last: null };

function frame(time) {
  const now = time / 1000;
  const dt = timer.last === null ? 1 / 60 : Math.min(Math.max(now - timer.last, 0), 0.1);
  timer.last = now;
  if (POSE) {
    applyChannels(debugChannels());
  } else {
    let viewer = null;
    if (renderer.xr.isPresenting) {
      const xrCam = renderer.xr.getCamera();
      xrState.frames += 1;
      // the XR camera carries the headset pose once a frame has been rendered with it
      if (xrState.place && xrState.frames > 2) {
        placeBust(xrCam);
        xrState.place = false;
      }
      if (!xrState.place) viewer = viewerFrom(xrCam);
    } else {
      smoothOrbit(dt);
      if (FIXED_VIEW) setView(); else placeOrbitCamera();
      camera.updateMatrixWorld(true);
      viewer = orbit.present ? viewerFrom(camera) : null;
      if (viewer && FIXED_VIEW) steerViewer(viewer);
    }
    H.channels = gazeStep(H.gaze, viewer, dt);
    if (FIXED_VIEW && !renderer.xr.isPresenting) {
      // close-ups: the head takes a third of its usual share and the eyes, still aimed at the
      // same point, make up the rest, so the motion shows where the camera is looking
      const c = H.channels, k = CLOSEUP_HEAD;
      applyChannels({ ...c, head_yaw: (c.head_yaw || 0) * k, head_pitch: (c.head_pitch || 0) * k,
                      head_roll: (c.head_roll || 0) * k });
      rideWithHead();
    } else {
      applyChannels(H.channels);
    }
  }
  renderer.render(scene, camera);
}

async function main() {
  try {
    const assets = await loadAll();
    buildBust(assets);
  } catch (e) {
    status('could not load the head: ' + e.message);
    throw e;
  }
  H.gaze = createGaze({ seed: Math.round(num('seed', 0)), rig: H.rigMaths });
  resize();
  setupLaptopInput();
  setupControls();
  if (!POSE && !Q.has('noxr')) setupXR();
  status('');
  renderer.setAnimationLoop(frame);
  window.__xr = { THREE, scene, camera, renderer, bust, H, applyChannels, orbit, placeBust, viewerFrom, ui, setViewName, setFollow };
  document.body.dataset.ready = '1';
}

main();
