import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUE_CYCLES_PER_SECOND,
  STICK_DEADZONE,
  deflection,
  nextHue,
  readLeftStick,
  readRightController,
  viewerHeading,
} from '../src/controllerInput.js';

function near(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

/** An XRInputSource-like object with an xr-standard gamepad (Quest Touch layout). */
function controller(handedness, { stick = [0, 0], a = false, b = false, mapping = 'xr-standard', hand = null } = {}) {
  const buttons = Array.from({ length: 7 }, () => ({ pressed: false, value: 0 }));
  buttons[4] = { pressed: a, value: a ? 1 : 0 };
  buttons[5] = { pressed: b, value: b ? 1 : 0 };
  return { handedness, hand, gamepad: { mapping, axes: [0, 0, stick[0], stick[1]], buttons } };
}

test('readRightController reads the right thumbstick (axes 2/3), A (button 4) and B (button 5)', () => {
  const state = readRightController([controller('left', { stick: [1, 0], a: true }), controller('right', { stick: [0.5, -0.25], a: true })]);
  assert.deepEqual(state, { stick: { x: 0.5, y: -0.25 }, aPressed: true, bPressed: false });
  assert.deepEqual(readRightController([controller('right', { b: true })]), { stick: { x: 0, y: 0 }, aPressed: false, bPressed: true });
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
  assert.deepEqual(readRightController([sparse]), { stick: { x: 0, y: 0 }, aPressed: false, bPressed: false });
});

test('readLeftStick reads the left thumbstick and ignores the right controller and hands', () => {
  assert.deepEqual(readLeftStick([controller('right', { stick: [1, 1] }), controller('left', { stick: [-0.5, 0.75] })]), { x: -0.5, y: 0.75 });
  assert.equal(readLeftStick([controller('right', { stick: [1, 0] })]), null);
  assert.equal(readLeftStick([controller('left', { hand: {} })]), null);
  assert.equal(readLeftStick(undefined), null);
});

test('deflection is 0 inside the dead zone, then rises to 1, clamping diagonals', () => {
  assert.equal(deflection({ x: STICK_DEADZONE * 0.9, y: 0 }), 0);
  near(deflection({ x: 0, y: -0.5 }), (0.5 - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  near(deflection({ x: 1, y: 1 }), 1);
});

test('nextHue advances with time and wraps round the colour wheel', () => {
  near(nextHue(0.1, 1), 0.1 + HUE_CYCLES_PER_SECOND);
  near(nextHue(0.9, 1 / HUE_CYCLES_PER_SECOND), 0.9);
  near(nextHue(0.95, 0.4), (0.95 + 0.4 * HUE_CYCLES_PER_SECOND) % 1);
  assert.ok(nextHue(0.99, 0.2) < 1);
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
