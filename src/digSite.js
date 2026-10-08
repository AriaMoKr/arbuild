import * as THREE from 'three';
import { Rocks, SHADOW_SCALE as ROCK_SHADOW_SCALE } from './rocks.js';
import { makeLook } from './styles.js';
import { GroundMarks, SPILL_CAPACITY, TRACK_CAPACITY, TRACK_STEP, spillMaterial, trackMaterial } from './groundMarks.js';

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

const HOME = { x: 190, z: -30 }; // where the excavator stands in the model, facing the rocks (-X)
const WHEEL_RADIUS = 52;
const HALF_TRACK = 85; // from the excavator's centre line to each row of wheels
const WORKER_HOME = { x: -150, z: 240, facing: deg(-20) }; // he faces his local +Z
// What each colour is, for looks that treat parts differently (src/styles.js).
const ROLES = new Map([
  [TYRE, 'tyre'],
  [HUB, 'metal'],
  [STEEL, 'metal'],
  [TEETH, 'metal'],
  [DARK, 'dark'],
  [SKIN, 'skin'],
  [HAT, 'hat'],
  [EYE, 'eye'],
]);

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
 * Builds the dig site. `site` is a group with its footprint centred on the origin and its
 * base at y = 0, in metres; `paint` is the excavator's paint material; `radius` is the
 * horizontal radius (metres) of a circle round the origin that holds the whole footprint
 * with the excavator at home, shadows included, whichever way the site is spun and
 * wherever the dig cycle has the arm; `height` is the tallest point and `lowest` the
 * lowest solid point over the cycle (metres; the rocks sit a few mm into the table on
 * purpose), `armLowest` the moving arm's lowest point (the bucket must never go below
 * the table, 0). `animate(t, dig)` poses the arm for dig time `dig` and the heads for
 * time `t` (seconds) and returns digPose(dig). Shadow meshes are marked with
 * `userData.shadow`, things lying flat on the table (marks, the diorama's ground) with
 * `userData.ground`. `shadowTexture` defaults to a soft radial gradient (needs a DOM
 * canvas). `style` is the look (src/styles.js).
 *
 * For driving (src/excavatorDrive.js), in the model frame (design units, the frame the
 * excavator moves in): `home` is where the excavator starts ({ x, z, heading }),
 * `bodyRadius` the circle round its centre that holds its body however it turns and
 * swings (the arm left out), `workerHome`/`workerRadius` the same for the worker, `rocks`
 * the rocks (src/rocks.js), `origin` the site's own origin, `marks` its tracks and spills
 * (src/groundMarks.js) and `wheels` where the wheels are, for the tracks.
 * `setDrive(state)` moves the excavator, `setWorker(state, swing)` the worker.
 */
export function createDigSite({ shadowTexture = createShadowTexture(), style = 'plain' } = {}) {
  // Every material and shape comes from the look (src/styles.js); 'standard' is the plain one.
  const look = makeLook(style);
  const model = new THREE.Group(); // design units
  const paint = look.material(PAINT, 'paint');
  const materials = new Map();
  const material = (m, role = ROLES.get(m) ?? 'cloth') => {
    if (typeof m !== 'number') return m;
    const key = `${m}:${role}`;
    if (!materials.has(key)) materials.set(key, look.material(m, role));
    return materials.get(key);
  };

  const add = (parent, geometry, m, position, rotation, role) => {
    const mesh = new THREE.Mesh(geometry, material(m, role));
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh);
    return mesh;
  };
  const box = (parent, [w, h, d], m, position, rotation) => add(parent, look.box(w, h, d), m, position, rotation);
  const cylinder = (parent, r, h, segments, m, position, rotation) => add(parent, look.cylinder(r, h, segments), m, position, rotation); // axis along Y
  const sphere = (parent, r, m, position) => add(parent, look.sphere(r), m, position);
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
  // Two parts, as on a real wheeled excavator: the chassis on its wheels (`excavator`,
  // which drives: setDrive() moves and turns it, its front is -X) and the house on top
  // (`house`: body, cab, operator and arm), which swings round on the chassis's centre.
  const excavator = new THREE.Group();
  excavator.position.set(HOME.x, 0, HOME.z);
  model.add(excavator);
  const wheels = [];
  for (const [x, z] of [[-130, HALF_TRACK], [130, HALF_TRACK], [-130, -HALF_TRACK], [130, -HALF_TRACK]]) {
    const wheel = new THREE.Group(); // turns about its axle (Z) as it rolls
    wheel.position.set(x, WHEEL_RADIUS + 1, z);
    excavator.add(wheel);
    cylinder(wheel, WHEEL_RADIUS, 34, 12, TYRE, [0, 0, 0], alongZ);
    cylinder(wheel, 24, 36, 10, HUB, [0, 0, 0], alongZ);
    box(wheel, [30, 7, 3], DARK, [0, 0, Math.sign(z) * 19.5]); // a bar across the outer hub, to see it roll
    wheels.push({ wheel, side: Math.sign(z) }); // +1: the left side (the front is -X), -1: the right
  }
  box(excavator, [250, 36, 120], DARK, [0, 68, 0]); // undercarriage
  const house = new THREE.Group();
  excavator.add(house);
  box(house, [310, 110, 150], paint, [0, 140, 0]); // body
  box(house, [6, 82, 4], TYRE, [22, 126, 77]); // ladder on the front
  box(house, [6, 82, 4], TYRE, [72, 126, 77]);
  for (const y of [102, 126, 150]) box(house, [50, 5, 4], TYRE, [47, y, 77]);
  box(house, [60, 24, 70], DARK, [-85, 205, 0]); // boom mount
  box(house, [125, 50, 100], paint, [25, 219, 0]); // seat housing
  box(house, [44, 8, 50], TYRE, [60, 248, 0]); // seat
  box(house, [10, 56, 50], TYRE, [88, 276, 0]); // seat back
  for (const z of [-16, 16]) {
    beam(house, [8, 244, z], [12, 278], 5, 5, TYRE); // control lever
    sphere(house, 6, 0xc8402f, [12, 282, z]);
  }
  const boomFoot = [-85, 210];
  const elbow = [-197, 345];
  const hinge = [-397, 180];
  // The arm is a chain of joints, each turning about Z at its pivot pin: boom (at the
  // foot), arm (at the elbow), bucket (at the hinge). digPose() drives the angles.
  const boomJoint = new THREE.Group();
  boomJoint.position.set(boomFoot[0], boomFoot[1], 0);
  house.add(boomJoint);
  cylinder(house, 13, 56, 8, DARK, [boomFoot[0], boomFoot[1], 0], alongZ); // foot pin
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
  box(house, [26, 54, 34], shirt, [62, 279, 0]);
  for (const z of [-9, 9]) beam(house, [64, 256, z], [32, 258], 12, 13, 0x2b3a55); // thighs
  for (const z of [-16, 16]) beam(house, [60, 300, z], [14, 279], 9, 9, shirt); // arms
  const operatorHead = head(house, [60, 322, 0], 15, -Math.PI / 2);

  // ---------- Worker ----------
  // He walks about (setWorker()): his legs swing from the hips and his arms from the shoulders.
  const worker = new THREE.Group();
  worker.position.set(WORKER_HOME.x, 0, WORKER_HOME.z);
  worker.rotation.y = WORKER_HOME.facing;
  model.add(worker);
  const vest = 0xee6a24;
  const legs = [];
  const arms = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group(); // turns about X at the hip
    leg.position.set(s * 12, 86, 0);
    worker.add(leg);
    box(leg, [22, 12, 36], 0x5a3a22, [s * 2, -79, 5], [0, s * deg(12), 0]); // boot, toes out
    box(leg, [20, 74, 22], 0x34507a, [0, -37, 0]);
    legs.push({ limb: leg, side: s });
  }
  box(worker, [60, 72, 34], vest, [0, 121, 0]);
  box(worker, [62, 8, 36], 0xe3e8eb, [0, 108, 0]); // reflective band
  for (const s of [-1, 1]) {
    const arm = new THREE.Group(); // turns about X at the shoulder
    arm.position.set(s * 36, 145, 0);
    worker.add(arm);
    box(arm, [20, 24, 28], vest, [0, 0, 0], [0, 0, s * deg(22)]); // sleeve
    beam(arm, [s * 4, -7], [s * 18, -51], 11, 11, SKIN);
    sphere(arm, 8.5, SKIN, [s * 19, -57, 0]);
    arms.push({ limb: arm, side: s });
  }
  box(worker, [16, 10, 16], SKIN, [0, 161, 0]);
  const workerHead = head(worker, [0, 190, 0], 25, 0);

  // ---------- Rock pile ----------
  // Each rock is its own object, so the bucket can move them (src/rocks.js).
  // [x, z, width, height, depth, tilt about X, turn about Y, tilt about Z, colour]
  const ROCKS = [
    [-360, 40, 70, 44, 58, -8, 20, 0, 0x948b7e],
    [-425, 5, 54, 38, 50, 0, -15, -10, 0x847c70],
    [-315, 100, 46, 30, 40, 0, 40, 6, 0xa39a8c],
    [-435, 90, 60, 42, 52, 10, 5, 0, 0x8a8174],
  ];
  const rock = ([w, h, d], colour, position, rotation, i) => ({
    mesh: add(model, look.rock(w, h, d, i), colour, position, rotation, 'rock'),
    w,
    h,
    d,
  });
  const rockList = ROCKS.map(([x, z, w, h, d, rx, ry, rz, colour], i) => rock([w, h, d], colour, [x, h / 2 - 2, z], [deg(rx), deg(ry), deg(rz), 'YXZ'], i));
  // One on top of the pile.
  rockList.push(rock([40, 30, 36], 0x9c9386, [-395, 48, 62], [0, deg(30), deg(-12), 'YXZ'], ROCKS.length));

  // Soft contact shadows, [x, z, width, depth] in the model frame with the excavator at
  // home: each is the ellipse inscribed in that box. The excavator's drives with it, the
  // bucket's swings with the house, the worker's walks with him. The rocks make their own.
  const shadows = [
    { name: 'excavator', at: [190, -30, 380, 220], parent: excavator },
    { name: 'bucket', at: [-225, -30, 160, 130], parent: house },
    { name: 'worker', at: [-150, 240, 100, 80], parent: worker, turns: true },
  ];
  const shadowOf = (name) => shadows.find((s) => s.name === name).at;
  const ellipse = ([x, z, w, d], i, n) => [x + (w / 2) * Math.cos((i / n) * Math.PI * 2), z + (d / 2) * Math.sin((i / n) * Math.PI * 2)];

  /**
   * Poses the arm for dig time `dig` and the heads for clock time `t` (seconds; `dig`
   * defaults to `t`). Returns digPose(dig).
   */
  const animate = (t, dig = t) => {
    const pose = digPose(dig);
    boomJoint.rotation.z = pose.boom;
    armJoint.rotation.z = pose.arm;
    bucket.rotation.z = BUCKET_REST + pose.bucket;
    operatorHead.rotation.y = -Math.PI / 2 + 0.25 * pose.bucket; // follows the bucket a little
    return pose;
  };

  /**
   * Puts the worker where a worker state says (src/worker.js): { x, z, facing, headYaw }
   * in the model frame, with his legs and arms swung by `swing` radians.
   */
  const setWorker = ({ x, z, facing, headYaw }, swing = 0) => {
    worker.position.set(x, 0, z);
    worker.rotation.y = facing;
    workerHead.rotation.y = headYaw;
    for (const { limb, side } of legs) limb.rotation.x = side * swing;
    for (const { limb, side } of arms) limb.rotation.x = -side * swing * 0.8;
  };

  // Points along the arm from the elbow to the teeth, and the teeth alone, in the model
  // frame for the joints' current angles: what the worker keeps clear of, and where a
  // scoop picks rocks up.
  const toModel = (object, x, y) => {
    const p = new THREE.Vector3(x, y, 0);
    for (let o = object; o !== model; o = o.parent) {
      o.updateMatrix();
      p.applyMatrix4(o.matrix);
    }
    return { x: p.x, y: p.y, z: p.z };
  };
  const forearm = [hinge[0] - elbow[0], hinge[1] - elbow[1]];
  const armPoints = () => [
    ...[0, 0.25, 0.5, 0.75].map((f) => toModel(armJoint, forearm[0] * f, forearm[1] * f)),
    toModel(bucket, 0, 0),
    toModel(bucket, -65, -40),
    toModel(bucket, -137, -75),
  ];
  const teeth = () => toModel(bucket, -137, -75);

  /**
   * Puts the excavator where a drive state says (src/excavatorDrive.js): { x, z, heading,
   * swing, travel } in the model frame. The wheels roll with the distance driven, each
   * side its own when it turns.
   */
  const setDrive = ({ x, z, heading, swing, travel }) => {
    excavator.position.set(x, 0, z);
    excavator.rotation.y = heading;
    house.rotation.y = swing;
    for (const { wheel, side } of wheels) {
      // Turning anticlockwise (heading growing), the right side (-1) covers more ground.
      wheel.rotation.z = (travel - side * HALF_TRACK * heading) / WHEEL_RADIUS;
    }
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
  model.updateMatrixWorld(true);
  // The shadows: the worker's turns with him, so it counts as a circle; each rock's is
  // an ellipse SHADOW_SCALE times its footprint, turned with it, so also a circle.
  const shadowOutlines = [
    ...shadows.map(({ at, turns }) => (turns ? [at[0], at[1], Math.max(at[2], at[3]), Math.max(at[2], at[3])] : at)),
    ...rockList.map(({ mesh, w, d }) => {
      const size = Math.max(w, d) * ROCK_SHADOW_SCALE;
      return [mesh.position.x, mesh.position.z, size, size];
    }),
  ];
  for (const at of shadowOutlines) {
    for (let i = 0; i < 48; i++) {
      const [x, z] = ellipse(at, i, 48);
      v.set(x, 0, z);
      bounds.expandByPoint(v);
      footprint.push(x, z);
    }
  }
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  let radius = 0;
  for (let i = 0; i < footprint.length; i += 2) radius = Math.max(radius, Math.hypot(footprint[i] - cx, footprint[i + 1] - cz));

  // For driving: the circle round the excavator's centre that holds its body whichever
  // way it turns or swings (wheels, house and the chassis's shadow, not the arm, which may
  // reach over the edge), and the one round the worker, however he turns. In the model
  // frame, as their own positions are; the rocks give their own (Rocks.obstacles()).
  const flatPoints = (root, skip, shadow) => {
    const points = [];
    root.traverse((o) => {
      if (!o.isMesh || skip?.(o)) return;
      const position = o.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
        points.push([v.x, v.z]);
      }
    });
    for (let i = 0; i < 48; i++) points.push(ellipse(shadow, i, 48));
    return points;
  };
  const circleAround = (points, centre) => {
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p[1]);
    const c = centre ?? { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
    return { x: c.x, z: c.z, r: Math.max(...points.map(([x, z]) => Math.hypot(x - c.x, z - c.z))) };
  };
  const bodyRadius = circleAround(flatPoints(excavator, inArm, shadowOf('excavator')), HOME).r;
  const workerRadius = circleAround(flatPoints(worker, null, shadowOf('worker')), WORKER_HOME).r;

  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, toneMapped: false });
  look.shadow(shadowMaterial);
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  const rocks = new Rocks({ model, rocks: rockList, bucket, inside: new THREE.Vector3(-65, -40, 0), shadowMaterial, shadowGeometry });
  for (const { at, parent } of shadows) {
    const [x, z, w, d] = at;
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.copy(parent.worldToLocal(new THREE.Vector3(x, 1, z))); // the model's frame is the world here
    shadow.scale.set(w, d, 1);
    shadow.userData.shadow = true;
    parent.add(shadow);
  }

  // The look's extras (outlines, edges, dirt), after the measuring: they don't count.
  const pile = { x: -380, z: 55 };
  look.decorate({
    model,
    centre: { x: cx, z: cz },
    radius,
    pile,
    clear: [
      { ...HOME, r: bodyRadius },
      { ...WORKER_HOME, r: workerRadius },
      { ...pile, r: 130 },
    ],
  });

  // What the excavator leaves on the table (src/groundMarks.js): kept in every look, so
  // switching looks keeps them, but only shown in looks that want them.
  const marks = {
    tracks: new GroundMarks({ capacity: TRACK_CAPACITY, material: trackMaterial(), y: 0.3, size: [TRACK_STEP + 6, 34] }),
    spills: new GroundMarks({ capacity: SPILL_CAPACITY, material: spillMaterial(), y: 0.5, tinted: true }),
  };
  for (const { mesh } of Object.values(marks)) {
    mesh.visible = look.marks;
    model.add(mesh);
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
    house,
    animate,
    setDrive,
    setWorker,
    armPoints,
    teeth,
    rocks,
    home: { x: HOME.x, z: HOME.z, heading: 0 },
    bodyRadius,
    workerHome: { ...WORKER_HOME },
    workerRadius,
    origin: { x: cx, z: cz },
    marks,
    wheels: { halfTrack: HALF_TRACK, axle: 130 },
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
