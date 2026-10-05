// Driving the excavator round the table top, and swinging its cab, from the Touch
// controllers' thumbsticks. Pure functions on plain values, so they run under `node --test`.
//
// Everything is in the dig site's own frame: design units (0.5 mm at full size, see
// SITE_UNIT in digSite.js), x/z horizontal, angles about +Y (positive turns
// anticlockwise seen from above, as three.js's rotation.y does). The excavator's front,
// the bucket end, is its local -X, so heading h points it along (-cos h, sin h).
//
// The excavator only ever moves along its heading, forwards or backwards, never sideways.
// Speed and turning ramp up and down instead of jumping, and when it would leave the table
// or run into the worker or the rocks it stops where it touches.

import { STICK_DEADZONE, deflection } from './controllerInput.js';

export const MAX_DRIVE_SPEED = 300; // units/s: 15 cm/s at full size
export const DRIVE_ACCEL = 450; // units/s²: full speed after ~0.7 s
export const DRIVE_BRAKE = 900; // units/s²: stops from full speed in ~0.3 s
export const MAX_TURN_SPEED = Math.PI / 3; // rad/s
export const TURN_ACCEL = 4; // rad/s²
export const MAX_SWING_SPEED = Math.PI / 3; // rad/s: the cab on its wheels
export const SWING_ACCEL = 3; // rad/s²
const ABSOLUTE_TURN_GAIN = 3; // absolute steering: turn rate (rad/s) per radian still to turn

export const STEERING_MODES = ['relative', 'absolute'];

/** The drive state of an excavator parked at `home` ({ x, z, heading }). */
export function parkedAt(home) {
  return { x: home.x, z: home.z, heading: home.heading ?? 0, speed: 0, turnRate: 0, swing: 0, swingRate: 0, travel: 0 };
}

/** The unit vector { x, z } the excavator's front points along at `heading`. */
export function forwardOf(heading) {
  return { x: -Math.cos(heading), z: Math.sin(heading) };
}

/** `angle` wrapped into (-π, π]. */
export function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * A horizontal direction { x, z } in the parent frame, seen from a frame turned by
 * `angle` about +Y (its rotation.y): the inverse of what that rotation does to it.
 */
export function intoFrame(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

/** A direction in a frame turned by `angle`, back in its parent frame (three's rotation.y). */
export function outOfFrame(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, z: -v.x * s + v.z * c };
}

/** Moves `value` towards `target` by at most `step`. */
function approach(value, target, step) {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

/** Speeding up (same direction, faster) uses DRIVE_ACCEL; slowing down or reversing, DRIVE_BRAKE. */
function speedStep(speed, target) {
  const speedingUp = Math.abs(target) > Math.abs(speed) && Math.sign(target) * Math.sign(speed) >= 0;
  return speedingUp ? DRIVE_ACCEL : DRIVE_BRAKE;
}

/** One axis past the dead zone, from -1 to 1. */
function axis(value) {
  const magnitude = Math.min(1, Math.abs(value));
  return magnitude < STICK_DEADZONE ? 0 : (Math.sign(value) * (magnitude - STICK_DEADZONE)) / (1 - STICK_DEADZONE);
}

/**
 * The speed (units/s) and turn rate (rad/s) the left stick asks for.
 * - 'relative': forward/back drives along the excavator's heading, left/right turns it
 *   (right turns it clockwise seen from above, whether it's moving or not).
 * - 'absolute': the stick points where to go, seen by the user (`viewHeading`, the
 *   direction they face, in the site frame). The excavator turns to face that way and
 *   drives forwards, slowing while it still faces away and turning on the spot when
 *   it faces more than 90 degrees off.
 */
export function driveTargets(heading, stick, mode, viewHeading) {
  const amount = stick ? deflection(stick) : 0;
  if (amount === 0) return { speed: 0, turnRate: 0 };
  const length = Math.hypot(stick.x, stick.y);
  if (mode !== 'absolute') {
    return {
      speed: (-stick.y / length) * amount * MAX_DRIVE_SPEED, // stick y is negative when pushed forward
      turnRate: (-stick.x / length) * amount * MAX_TURN_SPEED,
    };
  }
  if (!viewHeading) return { speed: 0, turnRate: 0 };
  const right = { x: -viewHeading.z, z: viewHeading.x };
  const along = { x: right.x * stick.x - viewHeading.x * stick.y, z: right.z * stick.x - viewHeading.z * stick.y };
  const wanted = Math.atan2(along.z, -along.x); // the heading whose forward is `along`
  const error = wrapAngle(wanted - heading);
  return {
    speed: amount * MAX_DRIVE_SPEED * Math.max(0, Math.cos(error)),
    turnRate: Math.max(-MAX_TURN_SPEED, Math.min(MAX_TURN_SPEED, error * ABSOLUTE_TURN_GAIN)),
  };
}

/**
 * Whether an excavator whose body circle has radius `radius`, centred at `p`, is inside
 * the table and clear of every obstacle. `area` is the table top in the site frame:
 * { cx, cz, angle, halfX, halfZ }, centred at (cx, cz) and turned by `angle` (the
 * site's rotation.y on the table, so a site point d becomes outOfFrame(d, angle) in the
 * table's frame). `obstacles` are circles { x, z, r }.
 */
export function fits(p, radius, area, obstacles = []) {
  const t = outOfFrame({ x: p.x - area.cx, z: p.z - area.cz }, area.angle);
  const eps = 1e-6;
  if (Math.abs(t.x) > Math.max(0, area.halfX - radius) + eps) return false;
  if (Math.abs(t.z) > Math.max(0, area.halfZ - radius) + eps) return false;
  return obstacles.every((o) => Math.hypot(p.x - o.x, p.z - o.z) >= radius + o.r - eps);
}

/**
 * The nearest place to `p` where the excavator fits, for when it doesn't (the table's
 * outline changed): clamped into the table, pushed out of obstacles. Only this recovery
 * moves it sideways.
 */
export function settle(p, radius, area, obstacles = []) {
  let q = { ...p };
  for (let i = 0; i < 4 && !fits(q, radius, area, obstacles); i++) {
    const t = outOfFrame({ x: q.x - area.cx, z: q.z - area.cz }, area.angle);
    const hx = Math.max(0, area.halfX - radius);
    const hz = Math.max(0, area.halfZ - radius);
    const back = intoFrame({ x: Math.min(hx, Math.max(-hx, t.x)), z: Math.min(hz, Math.max(-hz, t.z)) }, area.angle);
    q = { x: area.cx + back.x, z: area.cz + back.z };
    for (const o of obstacles) {
      const dx = q.x - o.x;
      const dz = q.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = radius + o.r;
      if (d >= min) continue;
      const [ux, uz] = d > 1e-9 ? [dx / d, dz / d] : [1, 0];
      q = { x: o.x + ux * min, z: o.z + uz * min };
    }
  }
  return q;
}

/**
 * The drive state after `dt` seconds of input.
 * input: { stick (left thumbstick { x, y } or null), swingStick (right thumbstick or null),
 *          mode ('relative' | 'absolute'), viewHeading ({ x, z } in the site frame, or null) }
 * world: { area, radius (the body circle, arm excluded: it may reach past the edge), obstacles }
 * The result also says whether a move was cut short (`blocked`). `travel` adds up the
 * distance driven (negative backwards), for turning the wheels.
 */
export function stepDrive(state, input, world, dt) {
  const target = driveTargets(state.heading, input.stick, input.mode, input.viewHeading);
  const speed = approach(state.speed, target.speed, speedStep(state.speed, target.speed) * dt);
  const turnRate = approach(state.turnRate, target.turnRate, TURN_ACCEL * dt);
  const heading = state.heading + turnRate * dt;

  const swingTarget = input.swingStick ? 0 - axis(input.swingStick.x) * MAX_SWING_SPEED : 0; // right: clockwise (0 - keeps it +0)
  const swingRate = approach(state.swingRate, swingTarget, SWING_ACCEL * dt);
  const swing = state.swing + swingRate * dt;

  const { area, radius, obstacles } = world;
  let p = { x: state.x, z: state.z };
  if (!fits(p, radius, area, obstacles)) p = settle(p, radius, area, obstacles);
  const forward = forwardOf(heading);
  const step = speed * dt;
  const at = (f) => ({ x: p.x + forward.x * step * f, z: p.z + forward.z * step * f });
  let done = 1;
  if (step !== 0 && !fits(at(1), radius, area, obstacles)) {
    // Blocked: go as far as it fits along the way it's facing, then stop there.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (fits(at(mid), radius, area, obstacles)) lo = mid;
      else hi = mid;
    }
    done = lo;
  }
  const end = at(done);
  return {
    x: end.x,
    z: end.z,
    heading,
    speed: done < 1 ? 0 : speed,
    turnRate,
    swing,
    swingRate,
    travel: state.travel + step * done,
    blocked: done < 1,
  };
}

/** How hard the machine is working, 0..1, from driving and swinging (for the engine sound). */
export function driveLoad(state) {
  return Math.min(
    1,
    Math.max(Math.abs(state.speed) / MAX_DRIVE_SPEED, Math.abs(state.turnRate) / MAX_TURN_SPEED, Math.abs(state.swingRate) / MAX_SWING_SPEED),
  );
}
