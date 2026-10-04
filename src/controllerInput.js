// Touch controller input for the dig site: the left thumbstick slides it across the
// table, the right thumbstick spins it, and holding A cycles the excavator's paint colour.
// Pure functions on plain values, so they run under `node --test`.
//
// Quest Touch controllers use the WebXR 'xr-standard' gamepad layout:
// buttons[4] is A on the right controller (X on the left), and axes[2]/axes[3]
// are the thumbstick's x/y (axes[0]/axes[1] are touchpad placeholders, always 0).
// Thumbstick y is negative when the stick is pushed forward.

const A_BUTTON = 4;
const STICK_X = 2;
const STICK_Y = 3;

export const STICK_DEADZONE = 0.15;
export const MAX_SPIN_SPEED = Math.PI / 4; // rad/s at full deflection: one turn every 8 s
export const MAX_MOVE_SPEED = 0.25; // m/s at full deflection
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
 * Returns { stick: { x, y }, aPressed }.
 */
export function readRightController(inputSources) {
  const gamepad = controllerGamepad(inputSources, 'right');
  if (!gamepad) return null;
  return { stick: thumbstick(gamepad), aPressed: Boolean(gamepad.buttons[A_BUTTON]?.pressed) };
}

/** The left controller's thumbstick { x, y }, or null when there's no left controller. */
export function readLeftStick(inputSources) {
  const gamepad = controllerGamepad(inputSources, 'left');
  return gamepad ? thumbstick(gamepad) : null;
}

/** How far the stick is pushed past the dead zone, from 0 to 1. */
function deflection(stick) {
  const magnitude = Math.min(1, Math.hypot(stick.x, stick.y));
  return magnitude < STICK_DEADZONE ? 0 : (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}

/**
 * Spin speed for a thumbstick position. Any push past the dead zone spins the site,
 * faster the further the stick goes. Pushing right turns it clockwise seen from
 * above (negative yaw) and left turns it anticlockwise; a straight up/down push
 * keeps the previous direction. Returns { velocity (rad/s), direction (+1 | -1) }.
 */
export function spinVelocity(stick, previousDirection = -1) {
  const amount = deflection(stick);
  if (amount === 0) return { velocity: 0, direction: previousDirection };
  const direction = Math.abs(stick.x) >= STICK_DEADZONE ? (stick.x > 0 ? -1 : 1) : previousDirection;
  return { velocity: direction * amount * MAX_SPIN_SPEED, direction };
}

/** Hue (0..1) advanced by `dt` seconds of holding A. */
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

/** Keep a table-frame offset within ±limits on each axis. */
export function clampOffset(offset, limits) {
  return {
    x: Math.min(limits.x, Math.max(-limits.x, offset.x)),
    z: Math.min(limits.z, Math.max(-limits.z, offset.z)),
  };
}

/**
 * Reference-space { x, z } displacement for an offset given in the table's frame.
 * The table frame is the anchor's: rotated by `yaw` about +Y, so its X axis is
 * (cos yaw, -sin yaw) and its Z axis is (sin yaw, cos yaw) in the reference space.
 */
export function tableOffsetToWorld(offset, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: offset.x * c + offset.z * s, z: -offset.x * s + offset.z * c };
}

/**
 * The site's new offset from the table centre (in the table frame) after the stick
 * has been held for `dt` seconds. Movement is relative to where the user faces:
 * pushing forward slides the site away from them and right slides it to their right,
 * whatever the table's orientation. The result stays within ±limits so the site
 * doesn't leave the table top.
 */
export function slideOnTable(offset, stick, heading, yaw, limits, dt) {
  const amount = deflection(stick);
  if (amount === 0 || !heading) return clampOffset(offset, limits);

  const length = Math.hypot(stick.x, stick.y);
  const distance = amount * MAX_MOVE_SPEED * dt;
  const right = { x: -heading.z, z: heading.x };
  const forwardPush = -stick.y / length; // stick y is negative when pushed forward
  const rightPush = stick.x / length;
  const wx = (right.x * rightPush + heading.x * forwardPush) * distance;
  const wz = (right.z * rightPush + heading.z * forwardPush) * distance;

  // Reference space -> table frame (the inverse of tableOffsetToWorld).
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return clampOffset({ x: offset.x + wx * c - wz * s, z: offset.z + wx * s + wz * c }, limits);
}
