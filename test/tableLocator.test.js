import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DROPOUT_GRACE_MS,
  TableTracker,
  bearingTo,
  isTableLabel,
  pickTable,
  sameTable,
  polygonCentroid,
  polygonExtents,
  quarterTurnToward,
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
  // The user walks next to the far table; the site must not jump.
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
  const other = { name: 'other' };
  const viewer = { x: 0, y: 1.6, z: 0 };
  const tracker = new TableTracker();
  tracker.update([{ key: plane, top: { center: { x: 0, y: 0.7, z: -1 } } }, { key: other, top: { center: { x: 0, y: 0.7, z: -3 } } }], viewer);
  // Next frame: fresh candidate objects for the same XRPlanes, and the user is now nearer the other one.
  const moved = { key: plane, top: { center: { x: 0.01, y: 0.7, z: -1 } } };
  const result = tracker.update([{ key: other, top: { center: { x: 0, y: 0.7, z: -3 } } }, moved], { x: 0, y: 1.6, z: -2.8 });
  assert.equal(result, moved);
});

test('TableTracker cycle order is fixed where the lock was made, so walking up to the site still visits every table', () => {
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
    // Walk to within half a metre of the site's table before every press.
    const current = tables.find((t) => t.key === tracker.lockedKey).top.center;
    viewer = { x: current.x + 0.5, y: 1.6, z: current.z };
    assert.equal(tracker.update(tables, viewer).key, tracker.lockedKey); // still locked
    visited.push(tracker.next(tables, viewer).key.name);
    indices.push(tracker.indexOf(tables, viewer));
  }
  assert.deepEqual(visited, ['t1', 't2', 't3', 't4', 't1']);
  assert.deepEqual(indices, [0, 1, 2, 3, 0]);
});

test('TableTracker prefers a table in front of the viewer when it is about as close', () => {
  const behind = candidate('behind', 0, 1); // 1 m behind (viewer faces -Z)
  const ahead = candidate('ahead', 0.3, -2); // 2 m away, but in view: 2.0 beats 1 + OUT_OF_VIEW_PENALTY
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

test('pickTable never prefers a far table just because it is in view', () => {
  // The Quest 3 room from the debug log: four tables within 1.5 m, two about 9.5 m away
  // in another room. Facing the far ones, a near table beside the user must still win.
  const viewer = { x: 0, y: 1.2, z: 0, forward: { x: 0.7, y: 0, z: -0.71 } };
  const tables = [
    candidate('far-a', 7.593, -5.371),
    candidate('far-b', 6.736, -6.821),
    candidate('desk', -0.404, -0.715),
    candidate('side', 0.779, 0.422),
    candidate('back', 0.751, 1.399),
    candidate('near', 0.548, -0.366),
  ];
  assert.equal(pickTable(tables, viewer).key.name, 'near');
  // The old rule ("nearest table in view") picked the far one here: only it is in view,
  // and the table 0.9 m away is 74 degrees off to the side.
  assert.equal(pickTable([tables[1], tables[3]], viewer).key.name, 'side');
  // Facing a near table makes it win over a slightly nearer one out of view.
  const facingDesk = { x: 0, y: 1.2, z: 0, forward: { x: -0.5, y: 0, z: -0.87 } };
  assert.equal(pickTable(tables, facingDesk).key.name, 'desk');
  assert.equal(pickTable([], viewer), null);
  assert.equal(pickTable(tables, null).key.name, 'far-a'); // no viewer yet: first candidate
});

test('TableTracker re-picks while tables are still arriving, until the user takes control', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const far = candidate('far', 6.7, -6.8);
  const nearA = candidate('nearA', 0.5, -0.4);
  const nearB = candidate('nearB', -0.4, -0.7);

  const tracker = new TableTracker();
  assert.equal(tracker.update([far], viewer), far); // only the far table has arrived
  assert.equal(tracker.reason, 'first');
  assert.equal(tracker.update([far, nearB], viewer), nearB); // more arrive: pick again
  assert.equal(tracker.reason, 'tables changed');
  assert.equal(tracker.update([far, nearB, nearA], viewer), nearA);
  assert.equal(tracker.update([far, nearB, nearA], viewer), nearA); // settled: stays
  assert.equal(tracker.provisional, true);

  // Sliding or spinning the site confirms the table: later arrivals don't move it.
  const confirmed = new TableTracker();
  confirmed.update([far, nearB], viewer);
  confirmed.confirm();
  assert.equal(confirmed.update([far, nearB, nearA], viewer), nearB);

  // So does choosing a table with the trigger.
  const chosen = new TableTracker();
  chosen.update([far, nearB], viewer);
  assert.equal(chosen.next([far, nearB], viewer), far);
  assert.equal(chosen.reason, 'user');
  assert.equal(chosen.update([far, nearB, nearA], viewer), far);

  // A confirmed table that goes away is replaced.
  assert.equal(chosen.update([nearB, nearA], viewer), nearA);
  assert.equal(chosen.reason, 'table lost');
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

test('quarterTurnToward turns the front (+Z) to the viewer in steps of 90 degrees', () => {
  const centre = { x: 0, y: 0.7, z: -1.5 };
  const at = (x, z) => ({ x, y: 1.6, z });
  near(quarterTurnToward(at(0, 0), centre, 0), 0); // viewer on +Z: no turn
  near(quarterTurnToward(at(2, -1.5), centre, 0), Math.PI / 2); // viewer on +X
  near(quarterTurnToward(at(0, -3), centre, 0), Math.PI); // viewer behind
  near(quarterTurnToward(at(-2, -1.5), centre, 0), (3 * Math.PI) / 2); // viewer on -X
  // Relative to the table's yaw: a table turned 90 degrees needs a quarter turn less.
  near(quarterTurnToward(at(2, -1.5), centre, Math.PI / 2), 0);
  near(quarterTurnToward(at(0, 0), centre, -Math.PI / 2), Math.PI / 2);
  assert.equal(quarterTurnToward(null, centre, 0), 0);
  assert.equal(quarterTurnToward(at(0, -1.5), centre, 0), 0); // standing right over it
});

test('quarterTurnToward always leaves the front within 45 degrees of the viewer', () => {
  const centre = { x: 0.3, y: 0.7, z: -1.2 };
  for (let yaw = -Math.PI; yaw <= Math.PI; yaw += 0.37) {
    for (let a = 0; a < 2 * Math.PI; a += 0.29) {
      const viewer = { x: centre.x + 2 * Math.sin(a), y: 1.6, z: centre.z + 2 * Math.cos(a) };
      const turn = quarterTurnToward(viewer, centre, yaw);
      const front = { x: Math.sin(yaw + turn), z: Math.cos(yaw + turn) }; // three.js rotation.y of +Z
      const cos = front.x * Math.sin(a) + front.z * Math.cos(a);
      assert.ok(cos >= Math.SQRT1_2 - 1e-9, `yaw ${yaw.toFixed(2)}, viewer at ${a.toFixed(2)}: front is ${Math.acos(cos)} rad off`);
    }
  }
});

test('viewAngleTo measures the 3D angle from the gaze', () => {
  const viewer = { x: 0, y: 1.6, z: 0, forward: { x: 0, y: 0, z: -1 } };
  near(viewAngleTo({ x: 0, y: 1.6, z: -2 }, viewer), 0);
  near(viewAngleTo({ x: 0, y: 0.6, z: -1 }, viewer), Math.PI / 4); // 45 degrees below
  near(viewAngleTo({ x: 0, y: 1.6, z: 2 }, viewer), Math.PI);
  assert.equal(viewAngleTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), Infinity);
});

test('TableTracker rides out a brief dropout of the locked table', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const near = candidate('near', 0.5, -0.4);
  const other = candidate('other', -1, -1);
  const tracker = new TableTracker();
  assert.equal(tracker.update([near, other], viewer, 0), near);
  tracker.confirm(); // the user slid the site

  // The table is missing for a few frames: the lock and the last known top are kept.
  assert.equal(tracker.update([other], viewer, 11), near);
  assert.equal(tracker.update([], viewer, 300), near);
  assert.equal(tracker.lockedKey, near.key);
  assert.equal(tracker.provisional, false);

  // It comes back: still the same lock, no new pick.
  const back = { key: near.key, top: { center: { x: 0.51, y: 0.75, z: -0.4 } } };
  assert.equal(tracker.update([back, other], viewer, 320), back);
  assert.equal(tracker.reason, 'first');
});

test('TableTracker drops a table that stays missing past the grace period', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const near = candidate('near', 0.5, -0.4);
  const other = candidate('other', -1, -1);
  const tracker = new TableTracker();
  tracker.update([near, other], viewer, 0);
  assert.equal(tracker.update([other], viewer, 100), near);
  assert.equal(tracker.update([other], viewer, 100 + DROPOUT_GRACE_MS - 1), near);
  assert.equal(tracker.update([other], viewer, 100 + DROPOUT_GRACE_MS), other);
  assert.equal(tracker.reason, 'table lost');
  // Without a frame time there's no grace (unit tests and callers that don't track time).
  const untimed = new TableTracker();
  untimed.update([near, other], viewer);
  assert.equal(untimed.update([other], viewer), other);
});

test('TableTracker re-picks provisionally only when a new table arrives, not when one blinks', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const a = candidate('a', 0.5, -0.4);
  const b = candidate('b', -1, -1);
  const c = candidate('c', 0.3, 0.3); // nearer than a, arrives later
  const tracker = new TableTracker();
  assert.equal(tracker.update([a, b], viewer, 0), a);
  // b vanishes and comes back (its key was already seen): nothing to re-pick.
  assert.equal(tracker.update([a], viewer, 11), a);
  assert.equal(tracker.update([a, b], viewer, 22), a);
  assert.equal(tracker.reason, 'first');
  // c is new: the provisional pick is made again, and c is nearer.
  assert.equal(tracker.update([a, b, c], viewer, 33), c);
  assert.equal(tracker.reason, 'tables changed');
});

test('TableTracker keeps a table chosen with the trigger through a dropout', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const near = candidate('near', 0.5, -0.4);
  const far = candidate('far', 3, -3);
  const tracker = new TableTracker();
  tracker.update([near, far], viewer, 0);
  assert.equal(tracker.next([near, far], viewer), far);
  assert.equal(tracker.update([near], viewer, 500), far); // far blinks out
  assert.equal(tracker.update([near, far], viewer, 600), far);
  assert.equal(tracker.reason, 'user');
});

test('TableTracker recognises a table that comes back as a new object in the same place', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const near = candidate('near', 0.5, -0.4);
  const other = candidate('other', -1, -1);
  const tracker = new TableTracker();
  tracker.update([near, other], viewer, 0);
  const id = tracker.lockId;

  // Gone for a frame, then back as a new XRPlane object (what browsers do), 2 cm off.
  assert.equal(tracker.update([other], viewer, 11), near);
  const reborn = candidate('near again', 0.52, -0.4);
  assert.equal(tracker.update([other, reborn], viewer, 22), reborn);
  assert.equal(tracker.lockedKey, reborn.key);
  assert.equal(tracker.lockId, id); // not a new table: the app keeps the slide and spin
  assert.equal(tracker.reason, 'first');
  assert.equal(tracker.provisional, true); // and the reborn key isn't counted as a new arrival
  assert.equal(tracker.update([other, reborn], viewer, 33), reborn);

  // A genuinely different table nearby is not mistaken for it.
  const moved = new TableTracker();
  moved.update([near, other], viewer);
  assert.equal(moved.update([other, candidate('neighbour', 0.8, -0.4)], viewer).key.name, 'neighbour');
  assert.notEqual(moved.lockId, 0);
});

test('sameTable compares centres: within 15 cm across and 10 cm in height', () => {
  const at = (x, y, z) => ({ center: { x, y, z } });
  assert.equal(sameTable(at(0, 0.7, 0), at(0.1, 0.75, -0.1)), true);
  assert.equal(sameTable(at(0, 0.7, 0), at(0.2, 0.7, 0)), false);
  assert.equal(sameTable(at(0, 0.7, 0), at(0, 0.85, 0)), false);
});

test('TableTracker.lockId changes with every new pick, automatic or by the user', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const a = candidate('a', 0.5, -0.4);
  const b = candidate('b', -1, -1);
  const tracker = new TableTracker();
  tracker.update([a, b], viewer);
  const first = tracker.lockId;
  tracker.next([a, b], viewer);
  assert.equal(tracker.lockId, first + 1);
  tracker.reset();
  tracker.update([a, b], viewer);
  assert.equal(tracker.lockId, first + 2); // never reused across sessions
});

test('TableTracker reports each ridden-out dropout once, with how long and how it came back', () => {
  const viewer = { x: 0, y: 1.2, z: 0 };
  const near = candidate('near', 0.5, -0.4);
  const other = candidate('other', -1, -1);
  const tracker = new TableTracker();
  tracker.update([near, other], viewer, 1000);
  assert.equal(tracker.takeRecovery(), null);

  tracker.update([other], viewer, 1011); // gone
  tracker.update([other], viewer, 1022);
  assert.equal(tracker.takeRecovery(), null); // still missing: nothing to report yet
  tracker.update([near, other], viewer, 1033); // back, same object
  assert.deepEqual(tracker.takeRecovery(), { missingMs: 22, newObject: false });
  assert.equal(tracker.takeRecovery(), null); // only once

  // Swapped for a new object in the very same frame: reported with no missing time.
  const reborn = candidate('near again', 0.5, -0.41);
  tracker.update([reborn, other], viewer, 1044);
  assert.deepEqual(tracker.takeRecovery(), { missingMs: 0, newObject: true });

  // A table that stays gone is a new pick, not a recovery.
  tracker.update([other], viewer, 2000);
  tracker.update([other], viewer, 2000 + DROPOUT_GRACE_MS);
  assert.equal(tracker.reason, 'table lost');
  assert.equal(tracker.takeRecovery(), null);
});
