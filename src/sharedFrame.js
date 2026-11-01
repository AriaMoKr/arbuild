// The shared session's pure parts: the frame two headsets agree on at one table, who runs the
// simulation, how everyone's controller input is merged, and what a site message must look
// like. src/multiplayer.js uses them with three.js and the session layer; `node --test` runs
// them as they are.
//
// The frame: each headset sees the same table through its own Space Setup, so its table frame
// (centre, yaw) can differ from another's by a quarter turn (a rectangle has four fits), and
// the site's spin (quarterTurnToward) faces whoever placed it. So poses are shared in the site's
// frame turned by this headset's `turns` quarter turns, and both headsets choose `turns` the
// same way: they touch the same corner of the table, and the turn that brings that corner into
// the frame's +x +z quadrant is it (quarterTurnsFor). Until both have done that, turns is 0,
// which is right when both scans agree (and in the emulator).

import { intoFrame, wrapAngle } from './excavatorDrive.js';
import { snapQuarterTurn } from './tableLocator.js';

/** The app id every site on the origin uses, so rooms are shared between them (and the layer's test page can watch). */
export const APP_ID = 'ariamokr-layersharedsession-test';
/** This page's id in the session. */
export const PAGE_ID = 'arbuild';
export const STATE_HZ = 15; // how often the host sends the site, and a guest its input
export const INPUT_HOLD_MS = 400; // a guest's input counts for this long after it arrived
const STICK_DEAD = 0.15;

/**
 * The quarter turns (0..3) that bring `corner` ({ x, z }, a point in the table frame) into the
 * frame's +x +z quadrant: what two headsets that touched the same corner each apply to their
 * own table frame to agree on one.
 */
export function quarterTurnsFor(corner) {
  for (let k = 0; k < 4; k++) {
    const p = intoFrame(corner, (k * Math.PI) / 2);
    if (p.x >= 0 && p.z >= 0) return k;
  }
  return 0;
}

/** The site's spin as the session shares it: relative to the shared frame, not this headset's table frame. */
export function sharedSpin(siteSpin, turns) {
  return wrapAngle(siteSpin - (turns * Math.PI) / 2);
}

/** This headset's site spin for a shared one. */
export function siteSpinFrom(shared, turns) {
  return snapQuarterTurn(shared + (turns * Math.PI) / 2);
}

/**
 * Who runs the simulation: the member on this page with the lowest member id, this visitor
 * included. `peers` are the session's others (page, memberId); those without a hello yet
 * don't count. Returns that member id.
 */
export function electHost(selfMemberId, peers, page = PAGE_ID) {
  let host = selfMemberId;
  for (const p of peers) {
    if (p.page === page && p.memberId && p.memberId < host) host = p.memberId;
  }
  return host;
}

/** An input as it goes over the wire: { ls: [x, y], rs: [x, y], a, b }. */
export function packInput({ left, right, a, b }) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { ls: left ? [r3(left.x), r3(left.y)] : [0, 0], rs: right ? [r3(right.x), r3(right.y)] : [0, 0], a: Boolean(a), b: Boolean(b) };
}

/** Whether an input asks for anything: a stick past the dead zone, or a button held. */
export function inputActive(input) {
  const live = (s) => Math.hypot(s[0], s[1]) >= STICK_DEAD;
  return Boolean(input) && (live(input.ls) || live(input.rs) || input.a || input.b);
}

/** Whether `data` is an input message (packInput's shape). */
export function isInput(data) {
  const stick = (s) => Array.isArray(s) && s.length === 2 && s.every((v) => Number.isFinite(v) && Math.abs(v) <= 1);
  return Boolean(data) && typeof data === 'object' && stick(data.ls) && stick(data.rs) && typeof data.a === 'boolean' && typeof data.b === 'boolean';
}

/**
 * The host's own input merged with the guests' ({ input, at }, newest first): for each
 * control, the host's when it's in use, else the newest guest's that is and arrived within
 * INPUT_HOLD_MS of `now`. So whoever is pushing drives. Returns packInput's shape.
 */
export function mergeInputs(own, guests, now) {
  const live = (s) => Math.hypot(s[0], s[1]) >= STICK_DEAD;
  const fresh = guests.filter((g) => isInput(g.input) && now - g.at <= INPUT_HOLD_MS);
  const pick = (key, inUse) => {
    if (inUse(own[key])) return own[key];
    const g = fresh.find((g) => inUse(g.input[key]));
    return g ? g.input[key] : own[key];
  };
  return { ls: pick('ls', live), rs: pick('rs', live), a: pick('a', Boolean), b: pick('b', Boolean) };
}

/**
 * Whether `data` is a site message from the host: { n (sequence), full (m has every mark: for
 * a newcomer), e (excavator), w (worker), r (rocks), h (heaps), m (the tracks and dirt marks
 * since the last message, or all of them: { t, s }), hue, reset, spin }.
 */
export function isSiteMessage(data) {
  if (!data || typeof data !== 'object') return false;
  const nums = (o, keys) => o && typeof o === 'object' && keys.every((k) => Number.isFinite(o[k]));
  return (
    Number.isFinite(data.n) &&
    (data.full === undefined || typeof data.full === 'boolean') &&
    nums(data.e, ['x', 'z', 'heading', 'swing', 'travel', 'digTime', 'load']) &&
    nums(data.w, ['x', 'z', 'facing', 'stride', 'walk', 'headYaw']) &&
    Array.isArray(data.r) &&
    Array.isArray(data.h) &&
    data.m &&
    typeof data.m === 'object' &&
    Array.isArray(data.m.t) &&
    Array.isArray(data.m.s) &&
    Number.isFinite(data.reset) &&
    Number.isFinite(data.spin)
  );
}

/**
 * The host's tracks and dirt marks as a guest keeps them (`kept`, null at first), with a site
 * message's folded in. A full message (everything, for a newcomer) or a new reset count (the
 * host then sends every mark it has since) starts a new `epoch`; otherwise the message's marks
 * are added on. So none is lost when two messages come between frames, while the guest is out
 * of AR, or when its own site was reset. `total` counts the marks added in the epoch, so the
 * app can tell which are new (marksToApply). The lists keep only the last `caps` ({ t, s }:
 * the slots the marks have; older ones would be overwritten anyway).
 */
export function foldMarks(kept, msg, caps) {
  const { t, s } = msg.m;
  if (!kept || msg.full || msg.reset !== kept.reset) {
    return { epoch: (kept?.epoch ?? 0) + 1, reset: msg.reset, t: t.slice(-caps.t), s: s.slice(-caps.s), total: { t: t.length, s: s.length } };
  }
  return {
    epoch: kept.epoch,
    reset: kept.reset,
    t: t.length ? kept.t.concat(t).slice(-caps.t) : kept.t,
    s: s.length ? kept.s.concat(s).slice(-caps.s) : kept.s,
    total: { t: kept.total.t + t.length, s: kept.total.s + s.length },
  };
}

/**
 * What brings a guest's marks up to the host's `kept` (foldMarks) from `applied` ({ epoch, t,
 * s }: the epoch and totals last applied; null when the guest's own site was reset, replaced
 * or ran by itself since): `{ restore: true, t, s }` to put every mark back, or
 * `{ restore: false, t, s }` with only the new ones to add.
 */
export function marksToApply(applied, kept) {
  const same = Boolean(applied) && applied.epoch === kept.epoch;
  const nt = same ? kept.total.t - applied.t : Infinity;
  const ns = same ? kept.total.s - applied.s : Infinity;
  // More new ones than the lists keep: those older than the slots are gone, so all of them.
  if (!(nt >= 0 && nt <= kept.t.length && ns >= 0 && ns <= kept.s.length)) return { restore: true, t: kept.t, s: kept.s };
  return { restore: false, t: nt ? kept.t.slice(-nt) : [], s: ns ? kept.s.slice(-ns) : [] };
}

/**
 * A guest's drive state eased towards the host's: positions and angles move a share of the
 * way each frame (`rate` per second), so the 15 messages a second don't show as steps. An
 * infinite `dt` jumps there.
 */
export function easeTowards(current, target, dt, rate = 20) {
  const k = 1 - Math.exp(-rate * dt);
  const angle = (a, b) => a + wrapAngle(b - a) * k;
  return {
    ...current,
    x: current.x + (target.x - current.x) * k,
    z: current.z + (target.z - current.z) * k,
    heading: angle(current.heading, target.heading),
    swing: angle(current.swing, target.swing),
    travel: current.travel + (target.travel - current.travel) * k,
    speed: 0,
    turnRate: 0,
    swingRate: 0,
  };
}
