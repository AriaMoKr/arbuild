import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_ACCEL,
  MAX_DRIVE_SPEED,
  MAX_SWING_SPEED,
  MAX_TURN_SPEED,
  driveLoad,
  driveTargets,
  fits,
  forwardOf,
  intoFrame,
  outOfFrame,
  parkedAt,
  settle,
  stepDrive,
  wrapAngle,
} from '../src/excavatorDrive.js';

function near(actual, expected, eps = 1e-9, label = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
}

const DT = 1 / 72;
const OPEN = { area: { cx: 0, cz: 0, angle: 0, halfX: 1e6, halfZ: 1e6 }, radius: 200, obstacles: [] }; // nothing in the way

/** Holds the inputs for `seconds`, stepping at 72 Hz like the Quest. */
function drive(state, input, seconds, world = OPEN) {
  let s = state;
  for (let i = 0; i < Math.round(seconds / DT); i++) s = stepDrive(s, { mode: 'relative', ...input }, world, DT);
  return s;
}

const parked = (heading = 0) => parkedAt({ x: 0, z: 0, heading });

test('forwardOf matches three.js turning the model frame: the front is local -X', () => {
  for (const h of [0, 0.4, Math.PI / 2, -2.2]) {
    const f = forwardOf(h);
    const viaRotation = outOfFrame({ x: -1, z: 0 }, h);
    near(f.x, viaRotation.x);
    near(f.z, viaRotation.z);
  }
  near(forwardOf(Math.PI / 2).z, 1); // a quarter turn anticlockwise from -X faces +Z
});

test('intoFrame undoes outOfFrame, and wrapAngle keeps angles in (-π, π]', () => {
  const v = { x: 0.3, z: -1.2 };
  const back = intoFrame(outOfFrame(v, 0.7), 0.7);
  near(back.x, v.x);
  near(back.z, v.z);
  near(wrapAngle(3 * Math.PI / 2), -Math.PI / 2);
  near(wrapAngle(-Math.PI / 2 - 2 * Math.PI), -Math.PI / 2);
});

test('relative: the stick drives along the heading, ramping up rather than jumping', () => {
  const first = stepDrive(parked(), { stick: { x: 0, y: -1 }, mode: 'relative' }, OPEN, 0.1);
  near(first.speed, DRIVE_ACCEL * 0.1, 1e-9, 'speed after 0.1 s');
  const s = drive(parked(), { stick: { x: 0, y: -1 } }, 1.5);
  near(s.speed, MAX_DRIVE_SPEED, 1e-9, 'full speed');
  assert.ok(s.x < -300, `moved ${s.x} along -X`); // heading 0 faces -X
  near(s.z, 0, 1e-9, 'no sideways drift');
  near(s.heading, 0);
});

test('relative: it only ever moves along its heading, never sideways', () => {
  for (const heading of [0.5, 2, -1.3]) {
    for (const stick of [{ x: 0, y: -1 }, { x: 0.6, y: -0.8 }, { x: -0.3, y: 0.9 }]) {
      let s = parked(heading);
      for (let i = 0; i < 40; i++) {
        const next = stepDrive(s, { stick, mode: 'relative' }, OPEN, DT);
        const f = forwardOf(next.heading);
        const sideways = (next.x - s.x) * -f.z + (next.z - s.z) * f.x; // displacement across the heading
        near(sideways, 0, 1e-9, 'sideways step');
        s = next;
      }
    }
  }
});

test('relative: letting go brakes to a stop quickly, and it stays put', () => {
  const moving = drive(parked(), { stick: { x: 0, y: -1 } }, 1.5);
  const stopped = drive(moving, { stick: { x: 0, y: 0 } }, 0.4);
  assert.equal(stopped.speed, 0);
  const coasted = Math.hypot(stopped.x - moving.x, stopped.z - moving.z);
  assert.ok(coasted > 10 && coasted < 120, `coasted ${coasted} units`);
  const later = drive(stopped, { stick: null }, 1);
  assert.equal(later.x, stopped.x);
  assert.equal(later.z, stopped.z);
});

test('relative: right turns clockwise (negative), on the spot when not driving; back reverses', () => {
  const turned = drive(parked(), { stick: { x: 1, y: 0 } }, 1);
  assert.ok(turned.heading < -0.6 && turned.heading > -MAX_TURN_SPEED, `heading ${turned.heading}`);
  near(turned.x, 0);
  near(turned.z, 0);
  const left = drive(parked(), { stick: { x: -1, y: 0 } }, 1);
  assert.ok(left.heading > 0.6);
  const back = drive(parked(), { stick: { x: 0, y: 1 } }, 1);
  assert.ok(back.x > 100 && back.speed < 0, `reversed to x=${back.x}, speed ${back.speed}`);
  assert.ok(back.travel < 0);
});

test('relative: the dead zone does nothing', () => {
  const s = drive(parked(), { stick: { x: 0.1, y: -0.1 } }, 1);
  assert.deepEqual([s.x, s.z, s.heading], [0, 0, 0]);
});

test('absolute: it turns to face where the stick points, as the user sees it, then drives there', () => {
  // The user faces -Z; stick right means +X. The excavator faces -X, so it must turn round first.
  const view = { x: 0, z: -1 };
  const target = driveTargets(0, { x: 1, y: 0 }, 'absolute', view);
  near(target.speed, 0, 1e-9, 'no driving while facing the other way');
  assert.ok(Math.abs(target.turnRate) === MAX_TURN_SPEED);
  const s = drive(parked(), { stick: { x: 1, y: 0 }, mode: 'absolute', viewHeading: view }, 6);
  const f = forwardOf(s.heading);
  assert.ok(f.x > 0.999, `facing ${JSON.stringify(f)}`);
  assert.ok(s.x > 300, `drove to x=${s.x}`);
  // Never sideways or backwards on the way.
  assert.ok(s.travel > 0);
});

test('absolute: forward on the stick goes the way the user faces, whatever the excavator faces', () => {
  const view = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
  const s = drive(parked(2.5), { stick: { x: 0, y: -1 }, mode: 'absolute', viewHeading: view }, 6);
  const f = forwardOf(s.heading);
  near(f.x, view.x, 1e-3);
  near(f.z, view.z, 1e-3);
  const still = drive(parked(), { stick: { x: 0, y: -1 }, mode: 'absolute', viewHeading: null }, 1);
  assert.deepEqual([still.x, still.z, still.heading], [0, 0, 0]); // no idea where the user faces: stay
});

test('it stops at the table edge with its body circle touching it, and goes no further', () => {
  const world = { area: { cx: 0, cz: 0, angle: 0, halfX: 1000, halfZ: 600 }, radius: 200, obstacles: [] };
  const s = drive(parked(), { stick: { x: 0, y: -1 } }, 6, world);
  near(s.x, -800, 1e-3, 'stopped at');
  assert.equal(s.speed, 0);
  assert.equal(s.blocked, true);
  const pushing = drive(s, { stick: { x: 0, y: -1 } }, 1, world);
  near(pushing.x, -800, 1e-3, 'still at');
  // It can still turn there (its body is a circle), and drive away.
  const away = drive(drive(pushing, { stick: { x: 0, y: 1 } }, 1, world), { stick: null }, 0.5, world);
  assert.ok(away.x > -700);
});

test('the edge is the table\'s, even when the site sits turned on it', () => {
  // The site is turned a quarter on the table: the table's long side runs along the site's z.
  const world = { area: { cx: 100, cz: 0, angle: Math.PI / 2, halfX: 1000, halfZ: 400 }, radius: 100, obstacles: [] };
  const s = drive(parkedAt({ x: 100, z: 0, heading: 0 }), { stick: { x: 0, y: -1 } }, 6, world);
  near(s.x, 100 - 300, 1e-3, 'along the site x (the table\'s short side)');
  const t = drive(parkedAt({ x: 100, z: 0, heading: Math.PI / 2 }), { stick: { x: 0, y: -1 } }, 8, world);
  near(t.z, 900, 1e-3, 'along the site z (the table\'s long side)');
});

test('it stops at the worker or the rocks instead of driving through or sliding round them', () => {
  const world = { ...OPEN, obstacles: [{ x: -1000, z: 30, r: 100 }] };
  const s = drive(parked(), { stick: { x: 0, y: -1 } }, 6, world);
  near(Math.hypot(s.x + 1000, s.z - 30), 300, 1e-3, 'touching');
  near(s.z, 0, 1e-12, 'still on its line');
  assert.ok(fits(s, 200, world.area, world.obstacles));
});

test('settle puts an excavator that no longer fits (the table shrank) back on it, out of obstacles', () => {
  const area = { cx: 0, cz: 0, angle: 0.3, halfX: 500, halfZ: 400 };
  const obstacles = [{ x: 0, z: 0, r: 50 }];
  for (const p of [{ x: 2000, z: -900 }, { x: 0, z: 0 }, { x: 10, z: 280 }]) {
    const q = settle(p, 150, area, obstacles);
    assert.ok(fits(q, 150, area, obstacles), `${JSON.stringify(p)} -> ${JSON.stringify(q)}`);
  }
  // A driving step starts by settling, so a stale position is fixed even with no input.
  const s = stepDrive(parkedAt({ x: 5000, z: 0 }), { stick: null, mode: 'relative' }, { area, radius: 150, obstacles }, DT);
  assert.ok(fits(s, 150, area, obstacles));
});

test('the right stick swings the cab, ramping up; up/down alone does nothing', () => {
  const s = drive(parked(), { swingStick: { x: 1, y: 0 } }, 1);
  assert.ok(s.swing < -0.6 && s.swing > -MAX_SWING_SPEED, `swing ${s.swing}`);
  near(s.swingRate, -MAX_SWING_SPEED);
  assert.deepEqual([s.x, s.z, s.heading], [0, 0, 0]); // swinging doesn't move or turn the chassis
  const stopped = drive(s, { swingStick: { x: 0, y: 0 } }, 0.5);
  assert.equal(stopped.swingRate, 0);
  near(drive(parked(), { swingStick: { x: 0, y: -1 } }, 1).swing, 0);
  assert.ok(drive(parked(), { swingStick: { x: -1, y: 0 } }, 1).swing > 0.6);
});

test('driveLoad is 0 when still and 1 at full speed', () => {
  assert.equal(driveLoad(parked()), 0);
  near(driveLoad(drive(parked(), { stick: { x: 0, y: -1 } }, 1.5)), 1);
  const half = { ...parked(), swingRate: MAX_SWING_SPEED / 2 };
  near(driveLoad(half), 0.5);
});

test('travel adds up only the distance actually driven', () => {
  const world = { area: { cx: 0, cz: 0, angle: 0, halfX: 1000, halfZ: 600 }, radius: 200, obstacles: [] };
  const s = drive(parked(), { stick: { x: 0, y: -1 } }, 6, world);
  near(s.travel, 800, 1e-3);
});
