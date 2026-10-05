// Reading the Touch controllers for the dig site: thumbsticks, A and B, and which way the
// user is facing. src/excavatorDrive.js turns the sticks into driving and swinging.
// Pure functions on plain values, so they run under `node --test`.
//
// Quest Touch controllers use the WebXR 'xr-standard' gamepad layout:
// buttons[4] is A on the right controller (X on the left), buttons[5] is B (Y on the
// left), and axes[2]/axes[3] are the thumbstick's x/y (axes[0]/axes[1] are touchpad
// placeholders, always 0). Thumbstick y is negative when the stick is pushed forward.

const A_BUTTON = 4;
const B_BUTTON = 5;
const STICK_X = 2;
const STICK_Y = 3;

export const STICK_DEADZONE = 0.15;
export const HUE_CYCLES_PER_SECOND = 0.25; // a full trip round the colour wheel in 4 s

/** The xr-standard gamepad of the `handedness` controller, skipping hands; null if there isn't one. */
function controllerGamepad(inputSources, handedness) {
  for (const source of inputSources ?? []) {
    if (source.handedness !== handedness || source.hand || !source.gamepad) continue;
    if (source.gamepad.mapping === 'xr-standard') return source.gamepad;
  }
  return null;
}

function thumbstick(gamepad) {
  return { x: gamepad.axes[STICK_X] ?? 0, y: gamepad.axes[STICK_Y] ?? 0 };
}

/**
 * State of the right-hand controller among `inputSources`, or null when there isn't
 * one (no controller, hands only, or an unknown gamepad layout).
 * Returns { stick: { x, y }, aPressed, bPressed }.
 */
export function readRightController(inputSources) {
  const gamepad = controllerGamepad(inputSources, 'right');
  if (!gamepad) return null;
  return {
    stick: thumbstick(gamepad),
    aPressed: Boolean(gamepad.buttons[A_BUTTON]?.pressed),
    bPressed: Boolean(gamepad.buttons[B_BUTTON]?.pressed),
  };
}

/** The left controller's thumbstick { x, y }, or null when there's no left controller. */
export function readLeftStick(inputSources) {
  const gamepad = controllerGamepad(inputSources, 'left');
  return gamepad ? thumbstick(gamepad) : null;
}

/** How far the stick is pushed past the dead zone, from 0 to 1. */
export function deflection(stick) {
  const magnitude = Math.min(1, Math.hypot(stick.x, stick.y));
  return magnitude < STICK_DEADZONE ? 0 : (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}

/** Hue (0..1) advanced by `dt` seconds of holding the repaint button. */
export function nextHue(hue, dt) {
  return (hue + dt * HUE_CYCLES_PER_SECOND) % 1;
}

/**
 * The horizontal direction { x, z } (unit length) the user is facing, from the view's
 * forward and up vectors. When looking almost straight down at the table, forward
 * has no useful horizontal part, but the top of the view still points away from the
 * user, so `up` is used instead (negated when looking almost straight up, where it
 * points back at the user). Returns null if neither works.
 */
export function viewerHeading(forward, up) {
  const upSign = forward?.y > 0 ? -1 : 1;
  for (const [v, sign] of [
    [forward, 1],
    [up, upSign],
  ]) {
    if (!v) continue;
    const length = Math.hypot(v.x, v.z);
    if (length > 0.2) return { x: (sign * v.x) / length, z: (sign * v.z) / length };
  }
  return null;
}
