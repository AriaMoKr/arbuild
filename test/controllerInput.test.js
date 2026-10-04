import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUE_CYCLES_PER_SECOND,
  MAX_MOVE_SPEED,
  MAX_SPIN_SPEED,
  STICK_DEADZONE,
  clampOffset,
  cubeReach,
  nextHue,
  readLeftStick,
  readRightController,
  slideOnTable,
  spinVelocity,
  tableOffsetToWorld,
  viewerHeading,
} from '../src/controllerInput.js';

function near(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

/** An XRInputSource-like object with an xr-standard gamepad (Quest Touch layout). */
function controller(handedness, { stick = [0, 0], a = false, mapping = 'xr-standard', hand = null } = {}) {
  const buttons = Array.from({ length: 7 }, () => ({ pressed: false, value: 0 }));
  buttons[4] = { pressed: a, value: a ? 1 : 0 };
  return { handedness, hand, gamepad: { mapping, axes: [0, 0, stick[0], stick[1]], buttons } };
}

test('readRightController reads the right thumbstick (axes 2/3) and A (button 4)', () => {
  const state = readRightController([controller('left', { stick: [1, 0], a: true }), controller('right', { stick: [0.5, -0.25], a: true })]);
  assert.deepEqual(state, { stick: { x: 0.5, y: -0.25 }, aPressed: true });
  assert.equal(readRightController([controller('right')]).aPressed, false);
});

test('readRightController ignores hands, other layouts and missing gamepads', () => {
  assert.equal(readRightController([controller('left')]), null);
  assert.equal(readRightController([controller('right', { hand: {} })]), null);
  assert.equal(readRightController([controller('right', { mapping: '' })]), null);
  assert.equal(readRightController([{ handedness: 'right', gamepad: null }]), null);
  assert.equal(readRightController([]), null);
  assert.equal(readRightController(undefined), null);
});

test('readRightController tolerates short axes/buttons arrays', () => {
  const sparse = { handedness: 'right', gamepad: { mapping: 'xr-standard', axes: [], buttons: [] } };
  assert.deepEqual(readRightController([sparse]), { stick: { x: 0, y: 0 }, aPressed: false });
});

test('spinVelocity is zero inside the dead zone and keeps the last direction', () => {
  assert.deepEqual(spinVelocity({ x: 0, y: 0 }, 1), { velocity: 0, direction: 1 });
  assert.deepEqual(spinVelocity({ x: STICK_DEADZONE * 0.9, y: 0 }, -1), { velocity: 0, direction: -1 });
});

test('spinVelocity: right turns clockwise (negative yaw), left anticlockwise, full speed is slow', () => {
  near(spinVelocity({ x: 1, y: 0 }).velocity, -MAX_SPIN_SPEED);
  near(spinVelocity({ x: -1, y: 0 }).velocity, MAX_SPIN_SPEED);
  assert.ok(MAX_SPIN_SPEED <= Math.PI / 2, 'full deflection should stay a slow spin');
});

test('spinVelocity scales with deflection and clamps diagonals', () => {
  const half = spinVelocity({ x: 0.5, y: 0 }).velocity;
  near(half, -((0.5 - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * MAX_SPIN_SPEED);
  near(spinVelocity({ x: 1, y: 1 }).velocity, -MAX_SPIN_SPEED); // |stick| > 1 is clamped
});

test('spinVelocity: a straight up/down push spins in the previous direction', () => {
  near(spinVelocity({ x: 0, y: -1 }, 1).velocity, MAX_SPIN_SPEED);
  near(spinVelocity({ x: 0, y: 1 }, -1).velocity, -MAX_SPIN_SPEED);
  assert.equal(spinVelocity({ x: 0, y: 1 }).direction, -1); // default: clockwise
});

test('nextHue advances with time and wraps round the colour wheel', () => {
  near(nextHue(0.1, 1), 0.1 + HUE_CYCLES_PER_SECOND);
  near(nextHue(0.9, 1 / HUE_CYCLES_PER_SECOND), 0.9);
  near(nextHue(0.95, 0.4), (0.95 + 0.4 * HUE_CYCLES_PER_SECOND) % 1);
  assert.ok(nextHue(0.99, 0.2) < 1);
});

// ---------- left stick: sliding the cube across the table ----------

const FORWARD = { x: 0, z: -1 }; // facing -Z, the reference space's default "ahead"
const WIDE = { x: 10, z: 10 }; // limits that never clamp

test('readLeftStick reads the left thumbstick and ignores the right controller and hands', () => {
  assert.deepEqual(readLeftStick([controller('right', { stick: [1, 1] }), controller('left', { stick: [-0.5, 0.75] })]), { x: -0.5, y: 0.75 });
  assert.equal(readLeftStick([controller('right', { stick: [1, 0] })]), null);
  assert.equal(readLeftStick([controller('left', { hand: {} })]), null);
  assert.equal(readLeftStick(undefined), null);
});

test('viewerHeading uses the horizontal forward, or the view up vector when looking straight down', () => {
  const level = viewerHeading({ x: 0, y: 0, z: -2 }, { x: 0, y: 1, z: 0 });
  near(level.x, 0);
  near(level.z, -1);
  const pitchedDown = viewerHeading({ x: 0.3, y: -0.9, z: -0.3 }, null);
  near(Math.hypot(pitchedDown.x, pitchedDown.z), 1);
  near(pitchedDown.x, Math.SQRT1_2);
  // Looking straight down: the top of the view points away from the user.
  const down = viewerHeading({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 });
  near(down.z, -1);
  assert.equal(viewerHeading({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }), null);
  // Looking almost straight up the top of the view points back at the user, so it's flipped.
  const up = viewerHeading({ x: 0, y: 0.99, z: -0.14 }, { x: 0, y: 0.14, z: 0.99 });
  near(up.x, 0);
  near(up.z, -1);
  assert.equal(viewerHeading(undefined, undefined), null);
});

test('slideOnTable: forward moves the cube away from the user, right moves it to their right', () => {
  const step = MAX_MOVE_SPEED * 1; // full deflection for one second
  const forward = slideOnTable({ x: 0, z: 0 }, { x: 0, y: -1 }, FORWARD, 0, WIDE, 1);
  near(forward.x, 0);
  near(forward.z, -step);
  const right = slideOnTable({ x: 0, z: 0 }, { x: 1, y: 0 }, FORWARD, 0, WIDE, 1);
  near(right.x, step);
  near(right.z, 0);
  const back = slideOnTable({ x: 0.1, z: 0.2 }, { x: 0, y: 1 }, FORWARD, 0, WIDE, 0.5);
  near(back.z, 0.2 + step * 0.5);
});

test('slideOnTable is relative to the user, not to how the table is turned', () => {
  for (const yaw of [0.3, Math.PI / 2, -2.4]) {
    for (const heading of [FORWARD, { x: 1, z: 0 }, { x: -Math.SQRT1_2, z: Math.SQRT1_2 }]) {
      const offset = slideOnTable({ x: 0, z: 0 }, { x: 0, y: -1 }, heading, yaw, WIDE, 1);
      const world = tableOffsetToWorld(offset, yaw);
      // Pushing forward always moves along the heading in the reference space.
      near(world.x, heading.x * MAX_MOVE_SPEED);
      near(world.z, heading.z * MAX_MOVE_SPEED);
    }
  }
});

test('slideOnTable keeps the cube on the table and ignores the dead zone', () => {
  const limits = { x: 0.3, z: 0.1 };
  let offset = { x: 0, z: 0 };
  for (let i = 0; i < 100; i++) offset = slideOnTable(offset, { x: 1, y: 1 }, FORWARD, 0, limits, 0.1);
  assert.deepEqual(offset, { x: 0.3, z: 0.1 });
  assert.deepEqual(slideOnTable({ x: 0.05, z: 0 }, { x: STICK_DEADZONE * 0.5, y: 0 }, FORWARD, 0, limits, 1), { x: 0.05, z: 0 });
  // An offset outside the limits (the table outline shrank) is pulled back even without input.
  assert.deepEqual(slideOnTable({ x: 1, z: -1 }, { x: 0, y: 0 }, FORWARD, 0, limits, 1), { x: 0.3, z: -0.1 });
  assert.deepEqual(slideOnTable({ x: 0, z: 0 }, { x: 0, y: -1 }, null, 0, limits, 1), { x: 0, z: 0 });
});

test('slideOnTable scales with how far the stick is pushed', () => {
  const half = slideOnTable({ x: 0, z: 0 }, { x: 0.5, y: 0 }, FORWARD, 0, WIDE, 1);
  near(half.x, ((0.5 - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * MAX_MOVE_SPEED);
});

test('tableOffsetToWorld follows the anchor yaw convention', () => {
  // Table X axis is (cos yaw, -sin yaw); at +90 degrees it points along world -Z.
  const w = tableOffsetToWorld({ x: 1, z: 0 }, Math.PI / 2);
  near(w.x, 0);
  near(w.z, -1);
  const z = tableOffsetToWorld({ x: 0, z: 1 }, Math.PI / 2);
  near(z.x, 1);
  near(z.z, 0);
});

test('cubeReach grows from half an edge to the spun footprint and back', () => {
  near(cubeReach(0.1, 0, 0), 0.05);
  near(cubeReach(0.1, 0, Math.PI / 4), 0.05 * Math.SQRT2);
  near(cubeReach(0.1, 0, Math.PI / 2), 0.05);
  near(cubeReach(0.1, 0, -Math.PI / 4), 0.05 * Math.SQRT2);
  // Rounded corners reach a little less: (h - r)√2 + r.
  near(cubeReach(0.1, 0.06, Math.PI / 4), (0.05 - 0.006) * Math.SQRT2 + 0.006);
  near(cubeReach(0.1, 0.06, 0), 0.05);
});

test('clampOffset bounds each axis independently', () => {
  assert.deepEqual(clampOffset({ x: -5, z: 0.05 }, { x: 0.2, z: 0.1 }), { x: -0.2, z: 0.05 });
});
