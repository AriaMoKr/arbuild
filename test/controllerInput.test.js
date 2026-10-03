import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUE_CYCLES_PER_SECOND,
  MAX_SPIN_SPEED,
  STICK_DEADZONE,
  nextHue,
  readRightController,
  spinVelocity,
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
