import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TableTracker,
  bearingTo,
  isTableLabel,
  polygonCentroid,
  polygonExtents,
  sortByDistance,
  tableTopFromMesh,
  tableTopFromPlane,
  transformPoint,
  viewAngleTo,
  yawFromMatrix,
} from '../src/tableLocator.js';

const EPS = 1e-9;

function near(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} expected ${expected}, got ${actual}`);
}

function nearPoint(actual, expected, eps = 1e-6) {
  near(actual.x, expected.x, eps, 'x:');
  near(actual.y, expected.y, eps, 'y:');
  near(actual.z, expected.z, eps, 'z:');
}

/** Column-major matrix from three column vectors and a translation. */
function matrix(c0, c1, c2, t) {
  return [c0[0], c0[1], c0[2], 0, c1[0], c1[1], c1[2], 0, c2[0], c2[1], c2[2], 0, t[0], t[1], t[2], 1];
}

/** Rotation about +Y by `yaw`, then optionally flipped upside down (180 deg about X), at `t`. */
function planeMatrix({ yaw = 0, flipped = false, t = [0, 0, 0] } = {}) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const x = [c, 0, -s];
  const y = flipped ? [0, -1, 0] : [0, 1, 0];
  const z = flipped ? [-s, 0, -c] : [s, 0, c];
  return matrix(x, y, z, t);
}

function rect(minX, maxX, minZ, maxZ, { closed = false, clockwise = false } = {}) {
  let pts = [
    { x: minX, y: 0, z: minZ },
    { x: maxX, y: 0, z: minZ },
    { x: maxX, y: 0, z: maxZ },
    { x: minX, y: 0, z: maxZ },
  ];
  if (clockwise) pts = pts.reverse();
  if (closed) pts.push({ ...pts[0] });
  return pts;
}

// ---------- labels ----------

test('isTableLabel accepts table and the legacy desk label, case-insensitively and in CSV lists', () => {
  assert.equal(isTableLabel('table'), true);
  assert.equal(isTableLabel('Desk'), true);
  assert.equal(isTableLabel('couch, TABLE'), true);
  assert.equal(isTableLabel('tablet'), false);
  assert.equal(isTableLabel('other'), false);
  assert.equal(isTableLabel(''), false);
  assert.equal(isTableLabel(null), false);
  assert.equal(isTableLabel(undefined), false);
});

// ---------- matrix helpers ----------

test('transformPoint applies a column-major matrix', () => {
  const m = planeMatrix({ yaw: Math.PI / 2, t: [1, 2, 3] });
  // +90 deg about Y maps local +X to world -Z.
  nearPoint(transformPoint(m, 1, 0, 0), { x: 1, y: 2, z: 2 });
});

test('yawFromMatrix recovers yaw for upright and upside-down planes', () => {
  for (const yaw of [0, 0.4, -1.2, Math.PI / 2, 2.8]) {
    near(yawFromMatrix(planeMatrix({ yaw })), yaw, EPS);
    near(yawFromMatrix(planeMatrix({ yaw, flipped: true })), yaw, EPS);
  }
});

test('yawFromMatrix handles a Z-up mesh frame (IWER table volumes)', () => {
  const zUp = matrix([1, 0, 0], [0, 0, -1], [0, 1, 0], [0, 0, 0]);
  near(yawFromMatrix(zUp), 0, EPS);
});

// ---------- polygons ----------

test('polygonCentroid ignores a repeated closing vertex and winding direction', () => {
  const open = polygonCentroid(rect(0.2, 1.0, 0.1, 0.5));
  for (const options of [{ closed: true }, { clockwise: true }, { closed: true, clockwise: true }]) {
    const c = polygonCentroid(rect(0.2, 1.0, 0.1, 0.5, options));
    near(c.x, open.x);
    near(c.z, open.z);
    near(c.area, open.area);
  }
  near(open.x, 0.6);
  near(open.z, 0.3);
  near(open.area, 0.32);
});

test('polygonCentroid is area-weighted, not a vertex average', () => {
  // L-shape: a 2x1 bar plus a 1x1 block on top of its left end.
  const l = [
    { x: 0, z: 0 },
    { x: 2, z: 0 },
    { x: 2, z: 1 },
    { x: 1, z: 1 },
    { x: 1, z: 2 },
    { x: 0, z: 2 },
  ];
  const c = polygonCentroid(l);
  near(c.area, 3);
  near(c.x, (2 * 1 + 1 * 0.5) / 3);
  near(c.z, (2 * 0.5 + 1 * 1.5) / 3);
});

test('polygonCentroid falls back to the vertex average for degenerate input', () => {
  const c = polygonCentroid([
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 2, z: 0 },
  ]);
  assert.equal(c.area, 0);
  near(c.x, 1);
  assert.equal(polygonCentroid([]), null);
});

test('polygonExtents measures the bounding box', () => {
  assert.deepEqual(polygonExtents(rect(-0.6, 0.6, -0.3, 0.3, { closed: true })), { width: 1.2, depth: 0.6 });
  assert.deepEqual(polygonExtents([]), { width: 0, depth: 0 });
});

// ---------- table top from a plane ----------

test('tableTopFromPlane: upright plane centred on its origin', () => {
  const top = tableTopFromPlane(rect(-0.8, 0.8, -0.4, 0.4), planeMatrix({ t: [0.5, 0.75, -1] }));
  nearPoint(top.center, { x: 0.5, y: 0.75, z: -1 });
  near(top.width, 1.6);
  near(top.depth, 0.8);
  near(top.area, 1.28);
  near(top.yaw, 0);
});

test('tableTopFromPlane: upside-down plane (Quest/IWER table tops) with an off-centre polygon', () => {
  // Flipped frame maps local (x, z) to world (x, -z).
  const top = tableTopFromPlane(
    rect(0.2, 1.0, 0.1, 0.5, { closed: true }),
    planeMatrix({ flipped: true, t: [1, 0.7, -2] }),
  );
  nearPoint(top.center, { x: 1.6, y: 0.7, z: -2.3 });
  near(top.area, 0.32);
});

test('tableTopFromPlane: yawed, upside-down plane keeps the centre on the surface', () => {
  const yaw = 0.6;
  const top = tableTopFromPlane(rect(-0.5, 0.5, -0.25, 0.25, { closed: true }), planeMatrix({ yaw, flipped: true, t: [-1, 0.72, 0.3] }));
  nearPoint(top.center, { x: -1, y: 0.72, z: 0.3 });
  near(top.yaw, yaw);
});

test('tableTopFromPlane rejects vertical and degenerate planes', () => {
  const wall = matrix([1, 0, 0], [0, 0, 1], [0, -1, 0], [0, 1, -2]); // normal along +Z
  assert.equal(tableTopFromPlane(rect(-1, 1, -1, 1), wall), null);
  assert.equal(tableTopFromPlane([{ x: 0, z: 0 }, { x: 1, z: 0 }], planeMatrix()), null);
  assert.equal(tableTopFromPlane(null, planeMatrix()), null);
  const line = [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 2, z: 0 },
  ];
  assert.equal(tableTopFromPlane(line, planeMatrix()), null);
});

// ---------- table top from a mesh ----------

/** Box vertices in an IWER-style Z-up frame: origin at the top-face centre, spanning z from -height to 0. */
function zUpBoxVertices(width, depth, height) {
  const v = [];
  for (const x of [-width / 2, width / 2])
    for (const y of [-depth / 2, depth / 2])
      for (const z of [-height, 0]) v.push(x, y, z);
  return new Float32Array(v);
}

test('tableTopFromMesh: Z-up box volume gives the top-face centre', () => {
  const m = matrix([1, 0, 0], [0, 0, -1], [0, 1, 0], [0.069, 0.73, -1.572]);
  const top = tableTopFromMesh(zUpBoxVertices(1.2, 2.1, 0.73), m);
  nearPoint(top.center, { x: 0.069, y: 0.73, z: -1.572 }, 1e-5);
  near(top.width, 1.2, 1e-5);
  near(top.depth, 2.1, 1e-5);
  near(top.yaw, 0);
});

test('tableTopFromMesh: yawed box measures its own footprint, not the world AABB', () => {
  const yaw = Math.PI / 6;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Z-up frame turned by `yaw` about world up.
  const m = matrix([c, 0, -s], [-s, 0, -c], [0, 1, 0], [2, 0.8, 1]);
  const top = tableTopFromMesh(zUpBoxVertices(1.0, 0.5, 0.8), m);
  nearPoint(top.center, { x: 2, y: 0.8, z: 1 }, 1e-5);
  near(top.width, 1.0, 1e-5);
  near(top.depth, 0.5, 1e-5);
  near(top.yaw, yaw, 1e-9);
});

test('tableTopFromMesh rejects empty and flat input', () => {
  assert.equal(tableTopFromMesh(new Float32Array(0), planeMatrix()), null);
  assert.equal(tableTopFromMesh(null, planeMatrix()), null);
  assert.equal(tableTopFromMesh(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), planeMatrix()), null);
});

// ---------- choosing a table ----------

function candidate(name, x, z, y = 0.75) {
  return { key: { name }, top: { center: { x, y, z } } };
}

test('sortByDistance orders by horizontal distance only', () => {
  const a = candidate('a', 0, -2);
  const b = candidate('b', 0, -1, 1.9); // closer horizontally even though it is higher
  assert.deepEqual(
    sortByDistance([a, b], { x: 0, y: 1.6, z: 0 }).map((c) => c.key.name),
    ['b', 'a'],
  );
  assert.deepEqual(sortByDistance([a, b], null), [a, b]);
});

test('TableTracker picks the nearest table and stays on it as the user moves', () => {
  const near1 = candidate('near', 0, -1);
  const far = candidate('far', 0, -3);
  const tracker = new TableTracker();
  assert.equal(tracker.update([far, near1], { x: 0, y: 1.6, z: 0 }), near1);
  // The user walks next to the far table; the cube must not jump.
  assert.equal(tracker.update([far, near1], { x: 0, y: 1.6, z: -3 }), near1);
});

test('TableTracker re-picks when the locked table disappears, and handles none', () => {
  const a = candidate('a', 0, -1);
  const b = candidate('b', 0, -2);
  const tracker = new TableTracker();
  const viewer = { x: 0, y: 1.6, z: 0 };
  assert.equal(tracker.update([a, b], viewer), a);
  assert.equal(tracker.update([b], viewer), b);
  assert.equal(tracker.update([], viewer), null);
  assert.equal(tracker.lockedKey, null);
});

test('TableTracker.next cycles outward through every table and wraps', () => {
  const viewer = { x: 0, y: 1.6, z: 0 };
  const tables = [candidate('c', 0, -3), candidate('a', 0, -1), candidate('b', 0, -2)];
  const tracker = new TableTracker();
  tracker.update(tables, viewer);
  const visited = [tracker.lockedKey.name];
  for (let i = 0; i < 3; i++) visited.push(tracker.next(tables, viewer).key.name);
  assert.deepEqual(visited, ['a', 'b', 'c', 'a']);
  assert.equal(tracker.indexOf(tables, viewer), 0);
  assert.equal(new TableTracker().next([], viewer), null);
});

test('TableTracker keys on object identity across frames', () => {
  const plane = { name: 'p' };
  const tracker = new TableTracker();
  tracker.update([{ key: plane, top: { center: { x: 0, y: 0.7, z: -1 } } }], null);
  // Next frame: fresh candidate objects, same XRPlane.
  const moved = { key: plane, top: { center: { x: 0.01, y: 0.7, z: -1 } } };
  assert.equal(tracker.update([candidate('other', 0, -0.5), moved], { x: 0, y: 1.6, z: 0 }), moved);
});

test('TableTracker cycle order is fixed where the lock was made, so walking up to the cube still visits every table', () => {
  // The living_room tables from @iwer/sem, nearest-first from the origin.
  const tables = [
    candidate('t1', 1.26, -0.403),
    candidate('t2', -1.539, 0.204),
    candidate('t3', -1.534, -1.191),
    candidate('t4', 2.521, 1.017),
  ];
  const tracker = new TableTracker();
  let viewer = { x: 0, y: 1.6, z: 0 };
  tracker.update(tables, viewer);
  const visited = [tracker.lockedKey.name];
  const indices = [tracker.indexOf(tables, viewer)];
  for (let press = 0; press < 4; press++) {
    // Walk to within half a metre of the cube's table before every press.
    const current = tables.find((t) => t.key === tracker.lockedKey).top.center;
    viewer = { x: current.x + 0.5, y: 1.6, z: current.z };
    assert.equal(tracker.update(tables, viewer).key, tracker.lockedKey); // still locked
    visited.push(tracker.next(tables, viewer).key.name);
    indices.push(tracker.indexOf(tables, viewer));
  }
  assert.deepEqual(visited, ['t1', 't2', 't3', 't4', 't1']);
  assert.deepEqual(indices, [0, 1, 2, 3, 0]);
});

test('TableTracker prefers the nearest table in front of the viewer for the first pick', () => {
  const behind = candidate('behind', 0, 1); // 1 m behind (viewer faces -Z)
  const ahead = candidate('ahead', 0.3, -2.5); // farther, but in view
  const tracker = new TableTracker();
  const facingForward = { x: 0, y: 1.6, z: 0, forward: { x: 0, y: 0, z: -1 } };
  assert.equal(tracker.update([behind, ahead], facingForward), ahead);
  // Cycling still counts outward from where the lock was made: 'behind' is nearest.
  assert.equal(tracker.indexOf([behind, ahead], facingForward), 1);
  assert.equal(tracker.next([behind, ahead], facingForward), behind);

  // With nothing in view (or no facing direction) the nearest table wins.
  const facingAway = { x: 0, y: 1.6, z: 0, forward: { x: 1, y: 0, z: 0 } };
  assert.equal(new TableTracker().update([behind, ahead], facingAway), behind);
  assert.equal(new TableTracker().update([behind, ahead], { x: 0, y: 1.6, z: 0 }), behind);
});

test('bearingTo is positive to the right, negative to the left, null when undefined', () => {
  const viewer = { x: 0, y: 1.6, z: 0, forward: { x: 0, y: 0, z: -1 } };
  near(bearingTo({ x: 0, y: 0, z: -1 }, viewer), 0);
  near(bearingTo({ x: 1, y: 0, z: 0 }, viewer), Math.PI / 2);
  near(bearingTo({ x: -1, y: 0, z: 0 }, viewer), -Math.PI / 2);
  near(Math.abs(bearingTo({ x: 0, y: 0, z: 1 }, viewer)), Math.PI);
  assert.equal(bearingTo({ x: 0, y: 0, z: -1 }, { x: 0, y: 1.6, z: 0 }), null); // no forward
  assert.equal(bearingTo({ x: 0, y: 0, z: -1 }, { ...viewer, forward: { x: 0, y: -1, z: 0 } }), null); // looking straight down
});

test('viewAngleTo measures the 3D angle from the gaze', () => {
  const viewer = { x: 0, y: 1.6, z: 0, forward: { x: 0, y: 0, z: -1 } };
  near(viewAngleTo({ x: 0, y: 1.6, z: -2 }, viewer), 0);
  near(viewAngleTo({ x: 0, y: 0.6, z: -1 }, viewer), Math.PI / 4); // 45 degrees below
  near(viewAngleTo({ x: 0, y: 1.6, z: 2 }, viewer), Math.PI);
  assert.equal(viewAngleTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), Infinity);
});
