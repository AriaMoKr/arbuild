// The worker on the dig site watches the excavator and keeps out of its way: when the arm
// (where it is, or where the swing and the drive will have it in a moment) or the machine
// itself comes too close, he walks off to a clear spot on the table, then turns to watch
// again. Pure functions on plain numbers, so they run under `node --test`.
//
// Like src/excavatorDrive.js, everything is in the dig site's model frame (design units).
// He faces his local +Z, so facing f points him along (sin f, cos f).

import { fits, outOfFrame, settle, wrapAngle } from './excavatorDrive.js';

export const WALK_SPEED = 170; // units/s: about 8.5 cm/s for an 11 cm person
export const RUN_SPEED = 340; // when the arm is nearly on him
export const SAFE_GAP = 70; // units he keeps between himself and the arm or the machine
const ESCAPE_DISTANCE = 220; // how far he walks to get clear
const WALK_TURN_SPEED = 8; // rad/s, turning to where he's walking
const WATCH_TURN_SPEED = 1.5; // rad/s, turning round to keep the excavator in view
const HEAD_LIMIT = 1.1; // rad: further than this, he turns his body as well
const STRIDE = 55; // units per step
// When he sees where the swing and the drive will have taken the arm: a few moments
// ahead, so a spot he walks to is clear of the whole sweep, not just its next step.
export const LOOKAHEADS_S = [0.4, 0.8, 1.2];

/** The worker standing at `home` ({ x, z, facing }). */
export function standingAt(home) {
  return { x: home.x, z: home.z, facing: home.facing ?? 0, target: null, stride: 0, walk: 0, headYaw: 0 };
}

/**
 * Where `points` ({ x, z }, on the excavator) will be in `seconds` if the excavator keeps
 * going: turned about its centre by its turning and swinging, and moved along its heading.
 */
export function predictPoints(points, drive, seconds) {
  const turn = (drive.turnRate + drive.swingRate) * seconds;
  const shift = drive.speed * seconds;
  const forward = { x: -Math.cos(drive.heading + drive.turnRate * seconds), z: Math.sin(drive.heading + drive.turnRate * seconds) };
  return points.map((p) => {
    const r = outOfFrame({ x: p.x - drive.x, z: p.z - drive.z }, turn);
    return { x: drive.x + r.x + forward.x * shift, z: drive.z + r.z + forward.z * shift };
  });
}

/** The nearest of `threats` (circles { x, z, r }) to a worker of `radius` at `p`: { gap, x, z } or null. */
export function nearestThreat(p, radius, threats) {
  let best = null;
  for (const t of threats) {
    const gap = Math.hypot(p.x - t.x, p.z - t.z) - t.r - radius;
    if (!best || gap < best.gap) best = { gap, x: t.x, z: t.z };
  }
  return best;
}

/**
 * A clear spot to walk to, away from `threat`: straight away if that's clear (on the
 * table, out of the obstacles, `SAFE_GAP` from every threat), else the nearest direction
 * round from there that is, else the clearest one found.
 */
export function escapeSpot(p, threat, { radius, area, obstacles, threats }) {
  const length = Math.hypot(p.x - threat.x, p.z - threat.z);
  const away = length > 1e-6 ? { x: (p.x - threat.x) / length, z: (p.z - threat.z) / length } : { x: 1, z: 0 };
  let best = null;
  for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3, Math.PI]) {
    const dir = outOfFrame(away, turn);
    const spot = settle({ x: p.x + dir.x * ESCAPE_DISTANCE, z: p.z + dir.z * ESCAPE_DISTANCE }, radius, area, obstacles);
    const clear = nearestThreat(spot, radius, threats)?.gap ?? Infinity;
    if (clear >= SAFE_GAP + 20) return spot;
    if (!best || clear > best.clear) best = { spot, clear };
  }
  return best.spot;
}

function turnToward(angle, target, step) {
  const diff = wrapAngle(target - angle);
  return Math.abs(diff) <= step ? target : angle + Math.sign(diff) * step;
}

/**
 * The worker after `dt` seconds.
 * input: { threats (circles to keep SAFE_GAP from: the arm now and in a moment, the
 *          machine), watch ({ x, z } to look at), radius, area and obstacles (as for
 *          excavatorDrive.fits: where he may stand) }
 * `walk` (0..1) blends his walking pose in and out, `stride` counts steps for his legs.
 */
export function stepWorker(state, input, dt) {
  const { threats, watch, radius, area, obstacles } = input;
  let { x, z, facing, target, stride, walk, headYaw } = state;
  if (!fits({ x, z }, radius, area, obstacles)) ({ x, z } = settle({ x, z }, radius, area, obstacles)); // the table changed under him
  const threat = nearestThreat({ x, z }, radius, threats);
  if (threat && threat.gap < SAFE_GAP) {
    // In the way: walk off, unless he's already heading somewhere that will be clear.
    const targetClear = target && (nearestThreat(target, radius, threats)?.gap ?? Infinity) >= SAFE_GAP;
    if (!targetClear) target = escapeSpot({ x, z }, threat, { radius, area, obstacles, threats });
  }

  if (target) {
    const dx = target.x - x;
    const dz = target.z - z;
    const distance = Math.hypot(dx, dz);
    const urgent = threat && threat.gap < SAFE_GAP / 2;
    const step = Math.min(distance, (urgent ? RUN_SPEED : WALK_SPEED) * dt);
    if (distance > 1e-6) facing = turnToward(facing, Math.atan2(dx, dz), WALK_TURN_SPEED * dt);
    const next = { x: x + (dx / (distance || 1)) * step, z: z + (dz / (distance || 1)) * step };
    if (step > 0 && fits(next, radius, area, obstacles)) {
      x = next.x;
      z = next.z;
      stride += step / STRIDE;
    } else if (step > 0) {
      target = null; // something's in the way: stop here
    }
    if (distance - step < 1) target = null;
    headYaw += (0 - headYaw) * Math.min(1, 8 * dt); // looking where he's going
  } else if (watch) {
    const want = Math.atan2(watch.x - x, watch.z - z);
    if (Math.abs(wrapAngle(want - facing)) > HEAD_LIMIT) facing = turnToward(facing, want, WATCH_TURN_SPEED * dt);
    const look = Math.max(-HEAD_LIMIT, Math.min(HEAD_LIMIT, wrapAngle(want - facing)));
    headYaw += (look - headYaw) * Math.min(1, 6 * dt);
  }
  walk += ((target ? 1 : 0) - walk) * Math.min(1, 8 * dt);
  return { x, z, facing: wrapAngle(facing), target, stride, walk, headYaw };
}

/** The worker's limb swing (radians) for his pose: legs and arms swing with his steps. */
export function limbSwing(state) {
  return Math.sin(state.stride * Math.PI) * 0.5 * state.walk;
}
