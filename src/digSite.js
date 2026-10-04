import * as THREE from 'three';

// The dig site from the notebook sketch, built only from boxes, cylinders and spheres:
// a wheeled excavator with its operator, a worker in a hard hat and a pile of rocks.
//
// It's modelled in design units, the numbers from the Excavator Blockout canvas with
// y flipped to point up: the ground is y = 0 and the worker faces +Z (the site's
// front). SITE_UNIT turns them into metres, so at full size the excavator body is
// 15.5 cm long and the worker is 11 cm tall.
export const SITE_UNIT = 0.0005;

const PAINT = 0xf2b705;
const DARK = 0x3f4549;
const TYRE = 0x2e3236;
const HUB = 0xa7adb3;
const STEEL = 0x5c6166;
const TEETH = 0x3a3e42;
const SKIN = 0xe1b38f;
const HAT = 0xf4f4f2;
const EYE = 0x1e2124;

const deg = THREE.MathUtils.degToRad;

/**
 * The excavator's dig cycle, as joint angles (degrees, on top of the modelled pose) at
 * key times (seconds). Positive boom lowers it, positive arm folds it in towards the
 * machine, positive bucket curls it shut. Each segment between two keys is one phase,
 * named after the motion it ends with.
 */
export const DIG_KEYS = [
  { t: 0, boom: 0, arm: 0, bucket: 0 },
  { t: 1.4, boom: 6, arm: -10, bucket: -25, phase: 'reach' }, // out over the pile, bucket open
  { t: 2.4, boom: 2, arm: 2, bucket: 55, phase: 'scoop' }, // drag in and curl: rocks in (teeth stay ~3 mm above the table)
  { t: 3.6, boom: -14, arm: 10, bucket: 60, phase: 'lift' }, // up with the load
  { t: 4.6, boom: -10, arm: -12, bucket: -10, phase: 'dump' }, // reach out and open: rocks out
  { t: 6, boom: 0, arm: 0, bucket: 0, phase: 'return' },
];
export const DIG_CYCLE_S = DIG_KEYS[DIG_KEYS.length - 1].t;

/**
 * Joint angles (radians) at time `t` (seconds, any value: the cycle repeats), eased
 * within each segment, plus the phase being played and how fast the joints are moving
 * (0 still .. 1 fastest), for the hydraulics sound.
 */
export function digPose(t) {
  const now = digAngles(t);
  return { ...now, hydraulics: Math.min(1, jointSpeed(t) / maxJointSpeed()) };
}

/** Joint angles (radians) and phase at `time`, eased within the segment it falls in. */
function digAngles(time) {
  const u = ((time % DIG_CYCLE_S) + DIG_CYCLE_S) % DIG_CYCLE_S;
  let i = 0;
  while (i < DIG_KEYS.length - 2 && u >= DIG_KEYS[i + 1].t) i++;
  const a = DIG_KEYS[i];
  const b = DIG_KEYS[i + 1];
  const f = (u - a.t) / (b.t - a.t);
  const e = f * f * (3 - 2 * f); // smoothstep: start and stop gently
  const lerp = (key) => deg(a[key] + (b[key] - a[key]) * e);
  return { boom: lerp('boom'), arm: lerp('arm'), bucket: lerp('bucket'), phase: b.phase };
}

/** Summed joint speed (rad/s) around time `t`. */
function jointSpeed(t) {
  const dt = 1 / 60;
  const a = digAngles(t - dt);
  const b = digAngles(t + dt);
  return (Math.abs(b.boom - a.boom) + Math.abs(b.arm - a.arm) + Math.abs(b.bucket - a.bucket)) / (2 * dt);
}

let maxSpeed = null;
function maxJointSpeed() {
  if (maxSpeed === null) {
    maxSpeed = 1e-9;
    for (let i = 0; i < 600; i++) maxSpeed = Math.max(maxSpeed, jointSpeed((i / 600) * DIG_CYCLE_S));
  }
  return maxSpeed;
}

/**
 * Builds the dig site. Returns { site, paint, radius, height, lowest, armLowest, excavator, animate }: `site`
 * is a group with its footprint centred on the origin and its base at y = 0, in metres;
 * `paint` is the excavator's paint material; `radius` is the horizontal radius (metres)
 * of a circle round the origin that holds the whole footprint, shadows included,
 * whichever way the site is spun and wherever the dig cycle has the arm; `height` is
 * the tallest point and `lowest` the lowest solid point over the cycle (metres; the
 * rocks sit a few mm into the table on purpose), `armLowest` the moving arm's lowest
 * point (the bucket must never go below the table, 0). `animate(t)` poses the site for time `t`
 * (seconds) and returns digPose(t). Shadow meshes are marked with `userData.shadow`.
 * `shadowTexture` defaults to a soft radial gradient (needs a DOM canvas).
 */
export function createDigSite({ shadowTexture = createShadowTexture() } = {}) {
  const model = new THREE.Group(); // design units
  const paint = new THREE.MeshStandardMaterial({ color: PAINT, roughness: 0.55 });
  const materials = new Map();
  const material = (m) => {
    if (typeof m !== 'number') return m;
    if (!materials.has(m)) materials.set(m, new THREE.MeshStandardMaterial({ color: m, roughness: 0.75 }));
    return materials.get(m);
  };

  const add = (parent, geometry, m, position, rotation) => {
    const mesh = new THREE.Mesh(geometry, material(m));
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh);
    return mesh;
  };
  const box = (parent, [w, h, d], m, position, rotation) => add(parent, new THREE.BoxGeometry(w, h, d), m, position, rotation);
  const cylinder = (parent, r, h, segments, m, position, rotation) =>
    add(parent, new THREE.CylinderGeometry(r, r, h, segments), m, position, rotation); // axis along Y
  const sphere = (parent, r, m, position) => add(parent, new THREE.SphereGeometry(r, 16, 12), m, position);
  // A box stretched between two points in the XY plane, at the first point's z.
  const beam = (parent, [ax, ay, z = 0], [bx, by], thick, depth, m) =>
    box(parent, [Math.hypot(bx - ax, by - ay) + thick / 2, thick, depth], m, [(ax + bx) / 2, (ay + by) / 2, z], [0, 0, Math.atan2(by - ay, bx - ax)]);
  const alongZ = [Math.PI / 2, 0, 0];

  // A head facing local +Z, turned by `facing` about Y: eyes, a smile and a hard hat.
  // Returns its group, so it can be turned.
  const head = (parent, position, r, facing) => {
    const g = new THREE.Group();
    g.position.set(...position);
    g.rotation.y = facing;
    parent.add(g);
    sphere(g, r, SKIN, [0, 0, 0]);
    for (const s of [-1, 1]) sphere(g, r * 0.12, EYE, [s * 0.36 * r, 0.2 * r, 0.91 * r]);
    // Lower half of a thin ring, lying on the face.
    add(g, new THREE.TorusGeometry(0.34 * r, 0.06 * r, 6, 12, Math.PI), EYE, [0, -0.02 * r, 0.93 * r], [0, 0, Math.PI]);
    cylinder(g, 1.24 * r, 0.16 * r, 16, HAT, [0, 0.68 * r, 0]); // brim
    const crown = add(g, new THREE.SphereGeometry(1.04 * r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), HAT, [0, 0.68 * r, 0]);
    crown.scale.y = 0.7;
    return g;
  };

  // ---------- Excavator ----------
  const excavator = new THREE.Group();
  excavator.position.set(190, 0, -30);
  model.add(excavator);
  for (const [x, z] of [[-130, 85], [130, 85], [-130, -85], [130, -85]]) {
    cylinder(excavator, 52, 34, 12, TYRE, [x, 53, z], alongZ);
    cylinder(excavator, 24, 36, 10, HUB, [x, 53, z], alongZ);
  }
  box(excavator, [250, 36, 120], DARK, [0, 68, 0]); // undercarriage
  box(excavator, [310, 110, 150], paint, [0, 140, 0]); // body
  box(excavator, [6, 82, 4], TYRE, [22, 126, 77]); // ladder on the front
  box(excavator, [6, 82, 4], TYRE, [72, 126, 77]);
  for (const y of [102, 126, 150]) box(excavator, [50, 5, 4], TYRE, [47, y, 77]);
  box(excavator, [60, 24, 70], DARK, [-85, 205, 0]); // boom mount
  box(excavator, [125, 50, 100], paint, [25, 219, 0]); // seat housing
  box(excavator, [44, 8, 50], TYRE, [60, 248, 0]); // seat
  box(excavator, [10, 56, 50], TYRE, [88, 276, 0]); // seat back
  for (const z of [-16, 16]) {
    beam(excavator, [8, 244, z], [12, 278], 5, 5, TYRE); // control lever
    sphere(excavator, 6, 0xc8402f, [12, 282, z]);
  }
  const boomFoot = [-85, 210];
  const elbow = [-197, 345];
  const hinge = [-397, 180];
  // The arm is a chain of joints, each turning about Z at its pivot pin: boom (at the
  // foot), arm (at the elbow), bucket (at the hinge). digPose() drives the angles.
  const boomJoint = new THREE.Group();
  boomJoint.position.set(boomFoot[0], boomFoot[1], 0);
  excavator.add(boomJoint);
  cylinder(excavator, 13, 56, 8, DARK, [boomFoot[0], boomFoot[1], 0], alongZ); // foot pin
  beam(boomJoint, [0, 0], [elbow[0] - boomFoot[0], elbow[1] - boomFoot[1]], 34, 40, paint); // boom
  const armJoint = new THREE.Group();
  armJoint.position.set(elbow[0] - boomFoot[0], elbow[1] - boomFoot[1], 0);
  boomJoint.add(armJoint);
  cylinder(armJoint, 12, 50, 8, DARK, [0, 0, 0], alongZ); // elbow pin
  beam(armJoint, [0, 0], [hinge[0] - elbow[0], hinge[1] - elbow[1]], 30, 34, paint); // arm
  cylinder(armJoint, 11, 120, 8, DARK, [hinge[0] - elbow[0], hinge[1] - elbow[1], 0], alongZ); // hinge pin

  // Bucket: an open box hanging from the hinge, mouth and teeth toward the rocks.
  const BUCKET_REST = deg(45);
  const bucket = new THREE.Group();
  bucket.position.set(hinge[0] - elbow[0], hinge[1] - elbow[1], 0);
  bucket.rotation.z = BUCKET_REST;
  armJoint.add(bucket);
  box(bucket, [4, 80, 110], STEEL, [-2, -40, 0]);
  box(bucket, [130, 4, 110], STEEL, [-65, -2, 0]);
  box(bucket, [130, 4, 110], STEEL, [-65, -78, 0]);
  for (const z of [-53, 53]) box(bucket, [130, 80, 4], STEEL, [-65, -40, z]);
  for (const z of [-39, -13, 13, 39]) box(bucket, [16, 8, 12], TEETH, [-137, -75, z]);

  // Operator on the seat, hands on the levers, looking at the bucket (-X).
  const shirt = 0x3567a8;
  box(excavator, [26, 54, 34], shirt, [62, 279, 0]);
  for (const z of [-9, 9]) beam(excavator, [64, 256, z], [32, 258], 12, 13, 0x2b3a55); // thighs
  for (const z of [-16, 16]) beam(excavator, [60, 300, z], [14, 279], 9, 9, shirt); // arms
  const operatorHead = head(excavator, [60, 322, 0], 15, -Math.PI / 2);

  // ---------- Worker ----------
  const worker = new THREE.Group();
  worker.position.set(-150, 0, 240);
  worker.rotation.y = deg(-20);
  model.add(worker);
  const vest = 0xee6a24;
  for (const s of [-1, 1]) {
    box(worker, [22, 12, 36], 0x5a3a22, [s * 14, 7, 5], [0, s * deg(12), 0]); // boots, toes out
    box(worker, [20, 74, 22], 0x34507a, [s * 12, 49, 0]); // legs
  }
  box(worker, [60, 72, 34], vest, [0, 121, 0]);
  box(worker, [62, 8, 36], 0xe3e8eb, [0, 108, 0]); // reflective band
  for (const s of [-1, 1]) {
    box(worker, [20, 24, 28], vest, [s * 36, 145, 0], [0, 0, s * deg(22)]); // sleeves
    beam(worker, [s * 40, 138], [s * 54, 94], 11, 11, SKIN);
    sphere(worker, 8.5, SKIN, [s * 55, 88, 0]);
  }
  box(worker, [16, 10, 16], SKIN, [0, 161, 0]);
  const workerHead = head(worker, [0, 190, 0], 25, 0);

  // ---------- Rock pile ----------
  // [x, z, width, height, depth, tilt about X, turn about Y, tilt about Z, colour]
  const rocks = [
    [-360, 40, 70, 44, 58, -8, 20, 0, 0x948b7e],
    [-425, 5, 54, 38, 50, 0, -15, -10, 0x847c70],
    [-315, 100, 46, 30, 40, 0, 40, 6, 0xa39a8c],
    [-435, 90, 60, 42, 52, 10, 5, 0, 0x8a8174],
  ];
  for (const [x, z, w, h, d, rx, ry, rz, colour] of rocks) {
    box(model, [w, h, d], colour, [x, h / 2 - 2, z], [deg(rx), deg(ry), deg(rz), 'YXZ']);
  }
  box(model, [40, 30, 36], 0x9c9386, [-395, 48, 62], [0, deg(30), deg(-12), 'YXZ']); // on top of the pile

  // Soft contact shadows, [x, z, width, depth]: each is the ellipse inscribed in that box.
  const shadows = [[190, -30, 380, 220], [-225, -30, 160, 130], [-380, 55, 220, 170], [-150, 240, 100, 80]];

  /** Poses the joints and heads for time `t` (seconds); returns digPose(t). */
  const animate = (t) => {
    const pose = digPose(t);
    boomJoint.rotation.z = pose.boom;
    armJoint.rotation.z = pose.arm;
    bucket.rotation.z = BUCKET_REST + pose.bucket;
    operatorHead.rotation.y = -Math.PI / 2 + 0.25 * pose.bucket; // follows the bucket a little
    workerHead.rotation.y = 0.6 * Math.sin((2 * Math.PI * t) / 9); // looks around now and then
    return pose;
  };

  // Measure the footprint, shadows included, so that nothing hangs past a table edge,
  // over the whole dig cycle: the still parts once, the moving arm at many poses.
  const bounds = new THREE.Box3();
  const footprint = [];
  let lowest = Infinity;
  let armLowest = Infinity;
  const v = new THREE.Vector3();
  const measure = (root, skip) => {
    root.traverse((o) => {
      if (!o.isMesh || skip?.(o)) return;
      const position = o.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
        bounds.expandByPoint(v);
        footprint.push(v.x, v.z);
        lowest = Math.min(lowest, v.y);
      }
    });
  };
  const inArm = (o) => {
    for (let p = o; p; p = p.parent) if (p === boomJoint) return true;
    return false;
  };
  animate(0);
  model.updateMatrixWorld(true);
  measure(model, inArm);
  const SAMPLES = 48;
  for (let i = 0; i < SAMPLES; i++) {
    animate((i / SAMPLES) * DIG_CYCLE_S);
    model.updateMatrixWorld(true);
    const before = lowest;
    lowest = Infinity;
    measure(boomJoint);
    armLowest = Math.min(armLowest, lowest);
    lowest = Math.min(before, lowest);
  }
  animate(0);
  for (const [x, z, w, d] of shadows) {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      v.set(x + (w / 2) * Math.cos(a), 0, z + (d / 2) * Math.sin(a));
      bounds.expandByPoint(v);
      footprint.push(v.x, v.z);
    }
  }
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  let radius = 0;
  for (let i = 0; i < footprint.length; i += 2) radius = Math.max(radius, Math.hypot(footprint[i] - cx, footprint[i + 1] - cz));

  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, toneMapped: false });
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  for (const [x, z, w, d] of shadows) {
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(x, 1, z);
    shadow.scale.set(w, d, 1);
    shadow.userData.shadow = true;
    model.add(shadow);
  }

  model.position.set(-cx, 0, -cz);
  const site = new THREE.Group();
  site.add(model);
  site.scale.setScalar(SITE_UNIT);
  return {
    site,
    paint,
    radius: radius * SITE_UNIT,
    height: bounds.max.y * SITE_UNIT,
    lowest: lowest * SITE_UNIT,
    armLowest: armLowest * SITE_UNIT,
    excavator,
    animate,
  };
}

function createShadowTexture() {
  if (typeof document === 'undefined') return null; // node tests: no canvas
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.25)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
