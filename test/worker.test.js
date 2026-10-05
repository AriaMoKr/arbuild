import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fits, parkedAt } from '../src/excavatorDrive.js';
import { SAFE_GAP, WALK_SPEED, escapeSpot, limbSwing, nearestThreat, predictPoints, standingAt, stepWorker } from '../src/worker.js';

const AREA = { cx: 0, cz: 0, angle: 0, halfX: 1000, halfZ: 600 };
const RADIUS = 60;
const DT = 1 / 72;

function run(state, input, seconds) {
  let s = state;
  for (let i = 0; i < Math.round(seconds / DT); i++) s = stepWorker(s, { radius: RADIUS, area: AREA, obstacles: [], watch: null, threats: [], ...input }, DT);
  return s;
}

function near(actual, expected, eps = 1e-9, label = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
}

test('with nothing near, he stays put and turns to watch the excavator', () => {
  const start = standingAt({ x: 0, z: 0, facing: 0 }); // facing +Z
  // The excavator off to his right (+X): a quarter turn, beyond what his head turns alone.
  const s = run(start, { watch: { x: 500, z: 0 } }, 3);
  assert.equal(s.x, 0);
  assert.equal(s.z, 0);
  const lookingAt = s.facing + s.headYaw;
  near(lookingAt, Math.PI / 2, 0.02, 'body + head');
  assert.ok(Math.abs(s.headYaw) <= 1.1 + 1e-9);
  assert.equal(s.target, null);
  assert.equal(limbSwing(s), 0);
  // Slightly to one side, he only turns his head.
  const glance = run(start, { watch: { x: 100, z: 500 } }, 2);
  assert.equal(glance.facing, 0);
  near(glance.headYaw, Math.atan2(100, 500), 0.01);
});

test('when the arm comes close, he walks off to a clear spot, swinging his legs', () => {
  const threat = { x: 100, z: 0, r: 25 }; // just to his right
  const start = standingAt({ x: 0, z: 0, facing: 0 });
  const first = stepWorker(start, { threats: [threat], watch: null, radius: RADIUS, area: AREA, obstacles: [] }, DT);
  assert.ok(first.target, 'he picks somewhere to go');
  assert.ok(first.target.x < 0, 'away from the arm');
  let s = first;
  let swung = 0;
  for (let i = 0; i < 2 * 72; i++) {
    s = stepWorker(s, { threats: [threat], watch: null, radius: RADIUS, area: AREA, obstacles: [] }, DT);
    swung = Math.max(swung, Math.abs(limbSwing(s)));
  }
  assert.ok(nearestThreat(s, RADIUS, [threat]).gap >= SAFE_GAP, `still only ${nearestThreat(s, RADIUS, [threat]).gap} away`);
  assert.equal(s.target, null, 'and stops there');
  assert.ok(swung > 0.2, 'his legs swung');
  const walked = Math.hypot(s.x, s.z);
  assert.ok(walked <= WALK_SPEED * 2 + 1e-6);
});

test('cornered at the table edge, he goes round rather than off the table', () => {
  // He stands at the left edge; the arm comes from the right, so straight away is off the table.
  const p = { x: -1000 + RADIUS, z: 0 };
  const spot = escapeSpot(p, { x: p.x + 90, z: 0 }, { radius: RADIUS, area: AREA, obstacles: [], threats: [{ x: p.x + 90, z: 0, r: 25 }] });
  assert.ok(fits(spot, RADIUS, AREA, []), 'on the table');
  assert.ok(nearestThreat(spot, RADIUS, [{ x: p.x + 90, z: 0, r: 25 }]).gap >= SAFE_GAP, 'and clear');
});

test('he keeps out of rocks and the machine when he walks', () => {
  const rock = { x: -150, z: 0, r: 50 };
  const s = run(standingAt({ x: 0, z: 0, facing: 0 }), { threats: [{ x: 80, z: 0, r: 25 }], obstacles: [rock] }, 3);
  assert.ok(fits(s, RADIUS, AREA, [rock]), `ended at ${s.x}, ${s.z}, in the rock`);
});

test('predictPoints: the swing turns the arm about the excavator, driving moves it along', () => {
  const drive = { ...parkedAt({ x: 100, z: 0, heading: 0 }), swingRate: Math.PI / 2 };
  const [p] = predictPoints([{ x: 0, z: 0 }], drive, 1); // the bucket 100 units ahead (-X), swinging left
  near(p.x, 100, 1e-9);
  near(p.z, 100, 1e-9); // a quarter turn anticlockwise from -X is +Z
  const driving = { ...parkedAt({ x: 100, z: 0, heading: 0 }), speed: 50 };
  const [q] = predictPoints([{ x: 0, z: 0 }], driving, 2);
  near(q.x, -100, 1e-9);
  near(q.z, 0, 1e-9);
});
