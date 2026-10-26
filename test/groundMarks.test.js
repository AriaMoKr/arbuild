import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { forwardOf, parkedAt, stepDrive } from '../src/excavatorDrive.js';
import { GroundMarks, HEAP_LOAD_RADIUS, Heaps, TRACK_STEP, heapRadius, noTread, treadMarks } from '../src/groundMarks.js';

const WHEELS = { halfTrack: 85, axle: 130 };
const OPEN = { area: { cx: 0, cz: 0, angle: 0, halfX: 1e6, halfZ: 1e6 }, radius: 200, obstacles: [] };

function near(actual, expected, eps = 1e-9, label = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
}

/** Drives with `stick` for `seconds`, collecting the tread marks as app.js does, each with the state that made it. */
function driveMarks(stick, seconds, start = parkedAt({ x: 0, z: 0, heading: 0 })) {
  let state = start;
  let carry = noTread();
  const marks = [];
  for (let i = 0; i < Math.round(seconds * 72); i++) {
    const next = stepDrive(state, { stick, mode: 'relative' }, OPEN, 1 / 72);
    const tread = treadMarks(state, next, carry, WHEELS);
    carry = tread.carry;
    marks.push(...tread.marks.map((m) => ({ ...m, by: next })));
    state = next;
  }
  return { marks, state };
}

test('driving straight leaves a mark per wheel row every TRACK_STEP, behind it, along its heading', () => {
  const { marks, state } = driveMarks({ x: 0, y: -1 }, 2);
  const expected = 2 * Math.floor(state.travel / TRACK_STEP);
  assert.ok(Math.abs(marks.length - expected) <= 2, `${marks.length} marks for ${state.travel.toFixed(0)} units`);
  const last = marks.slice(-2);
  // Heading 0 faces -X, so the rear wheels are at +X; the two rows are 85 to either side.
  for (const m of last) {
    near(m.x, m.by.x + WHEELS.axle, 1e-6, 'rear axle');
    near(Math.abs(m.z - m.by.z), WHEELS.halfTrack, 1e-6, 'wheel row');
    near(m.yaw, m.by.heading);
  }
  assert.notEqual(Math.sign(last[0].z), Math.sign(last[1].z), 'one per side');
});

test('reversing leaves the marks at the front wheels', () => {
  const { marks } = driveMarks({ x: 0, y: 1 }, 1.5);
  assert.ok(marks.length > 4);
  near(marks.at(-1).x, marks.at(-1).by.x - WHEELS.axle, 1e-6);
});

test('turning on the spot leaves marks too (the rows roll opposite ways), and standing still none', () => {
  const turning = driveMarks({ x: 1, y: 0 }, 2);
  assert.ok(turning.marks.length >= 4, `${turning.marks.length} marks turning on the spot`);
  near(turning.state.x, 0);
  assert.equal(driveMarks({ x: 0, y: 0 }, 2).marks.length, 0);
});

test('the marks follow the heading on a turned excavator', () => {
  const { marks } = driveMarks({ x: 0, y: -1 }, 1, parkedAt({ x: 0, z: 0, heading: Math.PI / 2 }));
  const m = marks.at(-1);
  const f = forwardOf(m.by.heading);
  // Behind the centre, along the heading.
  const along = (m.x - m.by.x) * f.x + (m.z - m.by.z) * f.z;
  near(along, -WHEELS.axle, 1e-6);
});

test('GroundMarks keeps the newest marks up to its capacity and round-trips its state', () => {
  const marks = new GroundMarks({ capacity: 3, material: new THREE.MeshBasicMaterial(), y: 0.3, size: [30, 34] });
  assert.equal(marks.mesh.count, 3, 'all slots drawn, unused ones scaled to nothing');
  const matrix = new THREE.Matrix4();
  marks.mesh.getMatrixAt(0, matrix);
  assert.equal(new THREE.Vector3().setFromMatrixScale(matrix).length(), 0);

  for (let i = 0; i < 5; i++) marks.add({ x: i * 10, z: 0, yaw: 0 });
  assert.equal(marks.count, 3);
  assert.deepEqual(marks.state().map((s) => s[0]), [20, 30, 40], 'the oldest went');

  const copy = new GroundMarks({ capacity: 3, material: new THREE.MeshBasicMaterial(), y: 0.3, size: [30, 34] });
  copy.restore(JSON.parse(JSON.stringify(marks.state())));
  assert.deepEqual(copy.state(), marks.state());
  copy.restore([[1, 2, 'x'], null, [5, 6, 0, 30, 34, 0]]);
  assert.deepEqual(copy.state(), [[5, 6, 0, 30, 34, 0]], 'nonsense is skipped');
  copy.reset();
  assert.equal(copy.count, 0);
});

test('tinted marks darken with their tone', () => {
  const marks = new GroundMarks({ capacity: 2, material: new THREE.MeshBasicMaterial(), y: 0.5, tinted: true });
  assert.ok(marks.mesh.instanceColor, 'instance colours exist before any mark (for shader precompiling)');
  marks.add({ x: 0, z: 0, tone: 1 });
  const colour = new THREE.Color();
  marks.mesh.getColorAt(0, colour);
  assert.ok(colour.r < 0.6);
});

// ---------- heaps of earth ----------

const heaps = (capacity = 40) => new Heaps({ geometry: new THREE.BufferGeometry(), material: new THREE.MeshBasicMaterial(), capacity });

test('dumped earth starts a heap, or joins one it lands next to, which grows and shifts towards it', () => {
  const h = heaps();
  h.add(0, 0, 1);
  assert.equal(h.count, 1);
  near(heapRadius(1), HEAP_LOAD_RADIUS);
  h.add(500, 0, 1);
  assert.equal(h.count, 2, 'far away: a new heap');
  const joined = h.add(40, 0, 1); // 40 units from the first heap's centre, within its radius + join
  assert.equal(h.count, 2, 'nearby: joins the first');
  near(joined.loads, 2);
  assert.ok(joined.x > 0 && joined.x < 40, `the centre moved towards the drop: ${joined.x}`);
  assert.ok(heapRadius(2) > heapRadius(1) && heapRadius(8) === 2 * heapRadius(1), 'volume grows with the loads');
  near(h.loads, 3);
  assert.equal(h.add(0, 0, 0), null, 'nothing dumped, nothing added');
});

test('when every slot is taken, more earth joins the nearest heap', () => {
  const h = heaps(3);
  for (let i = 0; i < 3; i++) h.add(i * 1000, 0, 1);
  h.add(2000 + 300, 0, 1); // too far to join by itself
  assert.equal(h.count, 3);
  near(h.heaps[2].loads, 2);
});

test('scooping at a heap takes earth out of it, and takes it away when it is spent', () => {
  const h = heaps();
  h.add(0, 0, 2);
  near(h.scoop(10, 0, 1), 1);
  near(h.heaps[0].loads, 1);
  near(h.scoop(0, 0, 0.4), 0.4, 1e-9, 'a bucket with room for only a little');
  near(h.scoop(0, 0, 1), 0.6, 1e-9, 'the rest');
  assert.equal(h.count, 0);
  assert.equal(h.scoop(0, 0, 1), 0, 'nothing left there');
  h.add(0, 0, 1);
  assert.equal(h.scoop(HEAP_LOAD_RADIUS + 60, 0, 1), 0, 'too far from it');
});

test('the excavator driving through flattens heaps within its reach; the rest stay', () => {
  const h = heaps();
  h.add(0, 0, 1);
  h.add(300, 0, 1);
  const gone = h.flatten(20, 0, 100);
  assert.equal(gone.length, 1);
  near(gone[0].loads, 1);
  assert.equal(h.count, 1);
  assert.equal(h.heaps[0].x, 300);
  assert.deepEqual(h.flatten(1000, 1000, 100), []);
});

test('heightAt is a dome over each heap, zero elsewhere; obstacles are their circles', () => {
  const h = heaps();
  h.add(0, 0, 1);
  const r = heapRadius(1);
  assert.ok(h.heightAt(0, 0) > 0.4 * r && h.heightAt(0, 0) < 0.5 * r, `peak ${h.heightAt(0, 0)} for radius ${r}`);
  assert.ok(h.heightAt(r * 0.5, 0) < h.heightAt(0, 0) && h.heightAt(r * 0.5, 0) > 0);
  assert.equal(h.heightAt(r + 1, 0), 0);
  assert.deepEqual(h.obstacles(), [{ x: 0, z: 0, r }]);
});

test('heaps round-trip their state, skipping nonsense; every slot is drawn, empty ones scaled to nothing', () => {
  const h = heaps(4);
  h.add(10, 20, 1.5);
  h.add(300, 0, 1);
  const copy = heaps(4);
  copy.restore(JSON.parse(JSON.stringify(h.state())));
  assert.deepEqual(copy.state(), h.state());
  copy.restore([[1, 2, 0], [1, 2], 'x', [5, 6, 2]]);
  assert.deepEqual(copy.state(), [[5, 6, 2]]);
  assert.equal(copy.mesh.count, 4);
  const m = new THREE.Matrix4();
  copy.mesh.getMatrixAt(0, m);
  near(new THREE.Vector3().setFromMatrixScale(m).x, heapRadius(2), 1e-3); // the matrix holds float32
  copy.mesh.getMatrixAt(1, m);
  assert.equal(new THREE.Vector3().setFromMatrixScale(m).length(), 0);
  copy.reset();
  assert.equal(copy.count, 0);
});
