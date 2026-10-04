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
 * Builds the dig site. Returns { site, paint, radius, height }: `site` is a group with
 * its footprint centred on the origin and its base at y = 0, in metres; `paint` is the
 * excavator's paint material; `radius` is the horizontal radius (metres) of a circle
 * round the origin that holds the whole footprint, shadows included, whichever way the
 * site is spun; `height` is the tallest point (metres). Shadow meshes are marked with
 * `userData.shadow`.
 */
export function createDigSite() {
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
  beam(excavator, boomFoot, elbow, 34, 40, paint); // boom
  beam(excavator, elbow, hinge, 30, 34, paint); // arm
  for (const [[x, y], r, length] of [[boomFoot, 13, 56], [elbow, 12, 50], [hinge, 11, 120]]) {
    cylinder(excavator, r, length, 8, DARK, [x, y, 0], alongZ); // pivot pins
  }

  // Bucket: an open box hanging from the hinge, mouth and teeth toward the rocks.
  const bucket = new THREE.Group();
  bucket.position.set(hinge[0], hinge[1], 0);
  bucket.rotation.z = deg(45);
  excavator.add(bucket);
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
  head(excavator, [60, 322, 0], 15, -Math.PI / 2);

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
  head(worker, [0, 190, 0], 25, 0);

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

  // Measure the footprint, shadows included, so that nothing hangs past a table edge.
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const footprint = [];
  const v = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    const position = o.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
      bounds.expandByPoint(v);
      footprint.push(v.x, v.z);
    }
  });
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

  const shadowMaterial = new THREE.MeshBasicMaterial({ map: createShadowTexture(), transparent: true, depthWrite: false, toneMapped: false });
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
  return { site, paint, radius: radius * SITE_UNIT, height: bounds.max.y * SITE_UNIT };
}

function createShadowTexture() {
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
