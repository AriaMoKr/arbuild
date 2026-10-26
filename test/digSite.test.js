import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DIG_CYCLE_S, DIG_KEYS, createDigSite, digPose } from '../src/digSite.js';

const site = createDigSite({ shadowTexture: null }); // no DOM canvas in node

test('the dig cycle never takes the bucket below the table', () => {
  // Measured over the whole cycle. (The tilted rocks sit a few mm into the table on purpose.)
  assert.ok(site.armLowest > 0.001, `the arm's lowest point is ${(site.armLowest * 1000).toFixed(1)} mm`);
  assert.ok(site.lowest > -0.005, `lowest point ${(site.lowest * 1000).toFixed(1)} mm`);
});

test('the footprint circle and height cover the whole cycle, and stay table-sized', () => {
  assert.ok(site.radius > 0.2 && site.radius < 0.3, `radius ${site.radius}`);
  assert.ok(site.height > 0.15 && site.height < 0.25, `height ${site.height}`);
});

test('digPose loops smoothly and starts and ends at the modelled pose', () => {
  for (const t of [0, DIG_CYCLE_S, 2 * DIG_CYCLE_S, -DIG_CYCLE_S]) {
    const p = digPose(t);
    assert.ok(Math.abs(p.boom) + Math.abs(p.arm) + Math.abs(p.bucket) < 1e-9, `pose at ${t}`);
  }
  // No jumps: neighbouring samples differ by little.
  let previous = digPose(0);
  for (let i = 1; i <= 600; i++) {
    const p = digPose((i / 600) * DIG_CYCLE_S);
    const step = Math.abs(p.boom - previous.boom) + Math.abs(p.arm - previous.arm) + Math.abs(p.bucket - previous.bucket);
    assert.ok(step < 0.05, `jump of ${step} rad at sample ${i}`); // the fastest move is ~0.03 rad per 10 ms
    previous = p;
  }
});

test('digPose names each phase and reports joint speed for the hydraulics sound', () => {
  const phases = DIG_KEYS.slice(1).map((k) => k.phase);
  assert.deepEqual(phases, ['reach', 'scoop', 'lift', 'dump', 'return']);
  for (let i = 1; i < DIG_KEYS.length; i++) {
    const mid = (DIG_KEYS[i - 1].t + DIG_KEYS[i].t) / 2;
    assert.equal(digPose(mid).phase, DIG_KEYS[i].phase);
  }
  let max = 0;
  for (let i = 0; i < 600; i++) {
    const h = digPose((i / 600) * DIG_CYCLE_S).hydraulics;
    assert.ok(h >= 0 && h <= 1);
    max = Math.max(max, h);
  }
  assert.ok(max > 0.95, `fastest point should read about 1, got ${max}`);
  assert.ok(digPose(DIG_KEYS[1].t).hydraulics < 0.1, 'joints are nearly still at a key');
});

test('animate poses the arm by dig time, separately from the clock', () => {
  assert.equal(site.animate(2.0).phase, 'scoop');
  assert.equal(site.animate(2.0, 0.5).phase, 'reach'); // the clock runs on, the arm stays early in its cycle
  site.animate(0);
});

test('driving data: the excavator starts clear of the worker and the rocks, with room round its body', () => {
  // The body circle holds the wheels and the house however it turns, but not the arm.
  assert.ok(site.bodyRadius > 180 && site.bodyRadius < 240, `body radius ${site.bodyRadius} units`);
  const obstacles = [...site.rocks.obstacles(), { x: site.workerHome.x, z: site.workerHome.z, r: site.workerRadius }];
  assert.equal(obstacles.length, 6); // five rocks and the worker
  for (const o of obstacles) {
    const gap = Math.hypot(site.home.x - o.x, site.home.z - o.z) - site.bodyRadius - o.r;
    assert.ok(gap > 20, `only ${gap.toFixed(0)} units between the excavator and an obstacle at home`);
  }
});

test('setDrive moves and turns the chassis, swings the house, and rolls the wheels', () => {
  site.setDrive({ x: 50, z: -20, heading: 0.5, swing: -1, travel: 104 });
  assert.deepEqual(site.excavator.position.toArray(), [50, 0, -20]);
  assert.equal(site.excavator.rotation.y, 0.5);
  assert.equal(site.house.rotation.y, -1);
  // The house holds the arm, so swinging carries the bucket round with it.
  let bucketInHouse = false;
  site.house.traverse((o) => {
    if (o.geometry?.parameters?.width === 130) bucketInHouse = true; // the bucket's floor plates
  });
  assert.ok(bucketInHouse);
  // Driving straight on (no turn), every wheel turns by distance / radius.
  site.setDrive({ ...site.home, swing: 0, travel: 104 });
  const wheels = site.excavator.children.filter((c) => c.isGroup && c !== site.house);
  assert.equal(wheels.length, 4);
  for (const w of wheels) assert.ok(Math.abs(w.rotation.z - 2) < 1e-9, `wheel turned ${w.rotation.z}`);
  site.setDrive({ ...site.home, swing: 0, travel: 0 });
});

test('from home, the teeth reach the rock pile at the end of the reach, and dump in the same place', () => {
  site.animate(0, 1.4);
  const reach = site.teeth();
  site.animate(0, 4.6);
  const dump = site.teeth();
  site.animate(0);
  const nearest = Math.min(...site.rocks.obstacles().map((o) => Math.hypot(o.x - reach.x, o.z - reach.z)));
  assert.ok(nearest < 90, `the nearest rock is ${nearest.toFixed(0)} units from the teeth`);
  assert.ok(Math.hypot(dump.x - reach.x, dump.z - reach.z) < 30, 'without a swing, the dump is over the pile');
  assert.ok(dump.y > reach.y + 50, 'the bucket dumps from up high');
});

test('the diorama look: same layout, its ground and decorations lie on the table, never under it', () => {
  const diorama = createDigSite({ shadowTexture: null, style: 'diorama' });
  assert.ok(Math.abs(diorama.radius - site.radius) < 0.002, 'the same footprint, within 2 mm');
  assert.deepEqual(diorama.home, site.home);
  assert.equal(diorama.marks.tracks.mesh.visible, true);
  assert.equal(site.marks.tracks.mesh.visible, false, 'the plain look keeps its marks hidden');
  let ground = 0;
  diorama.site.updateMatrixWorld(true);
  diorama.site.traverse((o) => {
    if (!o.isMesh || !o.userData.ground || o.isInstancedMesh) return;
    ground++;
    const p = o.geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); // the site's frame, metres
      assert.ok(v.y >= -0.5 * 0.0005 - 1e-6, `a piece of ground goes ${(v.y * 1000).toFixed(2)} mm under the table`);
      assert.ok(Math.hypot(v.x, v.z) < diorama.radius * 1.02, `a piece of ground reaches ${Math.hypot(v.x, v.z).toFixed(3)} m out`);
    }
  });
  assert.ok(ground > 20, `${ground} pieces of ground`);
});

test('the arm points run from the elbow to the teeth, and the worker can be posed walking', () => {
  const points = site.armPoints();
  assert.equal(points.length, 7);
  const teeth = site.teeth();
  assert.deepEqual(points[6], teeth);
  assert.ok(points[0].y > points[6].y, 'the elbow is above the teeth');
  site.setWorker({ x: 0, z: 0, facing: 1, headYaw: 0.5 }, 0.4);
  site.setWorker({ ...site.workerHome, headYaw: 0 }, 0);
});

test('the bucket shows the earth it carries, and drops it from inside, between the hinge and the teeth', () => {
  const diorama = createDigSite({ shadowTexture: null, style: 'diorama' });
  const loadMesh = diorama.site.getObjectByName('earth');
  assert.ok(loadMesh, 'the dome of earth');
  diorama.setLoad(0);
  assert.equal(loadMesh.visible, false);
  diorama.setLoad(0.7);
  assert.equal(loadMesh.visible, true);
  assert.ok(Math.abs(loadMesh.scale.y - 0.7) < 1e-9);
  assert.equal(site.setLoad(0.7), undefined);
  // The plain look never shows it.
  assert.equal(site.site.getObjectByName('earth').visible, false);
  site.setLoad(0);

  diorama.animate(0, 4.6); // the end of the dump
  const inside = diorama.bucketInside();
  const teeth = diorama.teeth();
  const hinge = diorama.armPoints()[4];
  const between = (a, b, p) => Math.min(a.x, b.x) - 40 < p.x && p.x < Math.max(a.x, b.x) + 40;
  assert.ok(between(hinge, teeth, inside), `inside ${inside.x} between hinge ${hinge.x} and teeth ${teeth.x}`);
  assert.ok(inside.y > teeth.y, 'above the teeth when the bucket is open');
  diorama.animate(0);
  assert.equal(diorama.marks.heaps.count, 0);
  assert.equal(diorama.marks.heaps.mesh.visible, true);
  assert.equal(site.marks.heaps.mesh.visible, false);
  assert.equal(typeof diorama.rocks.groundAt, 'function');
});
