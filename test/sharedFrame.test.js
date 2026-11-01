import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intoFrame } from '../src/excavatorDrive.js';
import {
  INPUT_HOLD_MS,
  easeTowards,
  electHost,
  foldMarks,
  inputActive,
  isInput,
  isSiteMessage,
  marksToApply,
  mergeInputs,
  packInput,
  quarterTurnsFor,
  sharedSpin,
  siteSpinFrom,
} from '../src/sharedFrame.js';

function near(actual, expected, eps = 1e-9, label = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
}

test('quarterTurnsFor: the turns that bring the touched corner into the +x +z quadrant, so two scans of one table agree', () => {
  const corners = [
    { x: 0.6, z: 1 },
    { x: -0.6, z: 1 },
    { x: -0.6, z: -1 },
    { x: 0.6, z: -1 },
  ];
  const seen = new Set();
  for (const corner of corners) {
    const k = quarterTurnsFor(corner);
    const turned = intoFrame(corner, (k * Math.PI) / 2);
    assert.ok(turned.x >= 0 && turned.z >= 0, `corner ${JSON.stringify(corner)} with ${k} turns lands at ${JSON.stringify(turned)}`);
    seen.add(k);
  }
  assert.equal(seen.size, 4, 'each corner needs a different turn');
  // Headset B's table frame is A's turned a quarter: the same physical corner gives frames that agree.
  const cornerA = { x: 0.6, z: 1 };
  const cornerB = intoFrame(cornerA, Math.PI / 2); // as B sees it
  const a = intoFrame(cornerA, (quarterTurnsFor(cornerA) * Math.PI) / 2);
  const b = intoFrame(cornerB, (quarterTurnsFor(cornerB) * Math.PI) / 2);
  near(a.x, b.x, 1e-9, 'x');
  near(a.z, b.z, 1e-9, 'z');
});

test('the site spin shared and taken back round-trips, for any turns', () => {
  for (const turns of [0, 1, 2, 3]) {
    for (const spin of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const back = siteSpinFrom(sharedSpin(spin, turns), turns);
      near(Math.atan2(Math.sin(back - spin), Math.cos(back - spin)), 0, 1e-9, `spin ${spin} turns ${turns}`);
    }
  }
  // Two headsets a quarter turn apart in their table frames end up with the site turned the same way physically.
  const hostTurns = 0;
  const guestTurns = 1;
  const hostSpin = Math.PI / 2;
  const guestSpin = siteSpinFrom(sharedSpin(hostSpin, hostTurns), guestTurns);
  near(guestSpin, Math.PI, 1e-9, 'the guest adds its own quarter turn');
});

test('electHost picks the lowest member id on this page, self included; others pages and unsaid hellos do not count', () => {
  const peers = [
    { memberId: 'b222', page: 'arbuild' },
    { memberId: 'a111', page: 'hallway' },
    { memberId: null, page: null },
    { memberId: 'c333', page: 'arbuild' },
  ];
  assert.equal(electHost('d444', peers), 'b222');
  assert.equal(electHost('a000', peers), 'a000');
  assert.equal(electHost('zzzz', []), 'zzzz');
});

test('inputs pack to a small message, and only live ones count', () => {
  const packed = packInput({ left: { x: 0.12345, y: -1 }, right: null, a: true, b: 0 });
  assert.deepEqual(packed, { ls: [0.123, -1], rs: [0, 0], a: true, b: false });
  assert.ok(isInput(packed));
  assert.ok(!isInput({ ls: [2, 0], rs: [0, 0], a: false, b: false }), 'out of range');
  assert.ok(!isInput({ ls: [0, 0], rs: [0, 0], a: 1, b: false }), 'not booleans');
  assert.ok(!isInput(null));
  assert.ok(inputActive(packed));
  assert.ok(!inputActive({ ls: [0.1, 0], rs: [0, 0], a: false, b: false }), 'in the dead zone');
  assert.ok(inputActive({ ls: [0, 0], rs: [0, 0], a: false, b: true }));
});

test('mergeInputs: whoever is pushing drives, the host first; a stale guest input is ignored', () => {
  const idle = { ls: [0, 0], rs: [0, 0], a: false, b: false };
  const guest = { input: { ls: [0, -1], rs: [0, 0], a: true, b: false }, at: 1000 };
  const later = { input: { ls: [0, 0], rs: [1, 0], a: false, b: false }, at: 1100 };
  const merged = mergeInputs(idle, [later, guest], 1200);
  assert.deepEqual(merged, { ls: [0, -1], rs: [1, 0], a: true, b: false });
  // The host's own stick wins over a guest's.
  assert.deepEqual(mergeInputs({ ...idle, ls: [0, 1] }, [guest], 1200).ls, [0, 1]);
  // Too old: forgotten.
  assert.deepEqual(mergeInputs(idle, [guest], 1000 + INPUT_HOLD_MS + 1), idle);
  assert.deepEqual(mergeInputs(idle, [{ input: 'junk', at: 1200 }], 1200), idle);
});

test('isSiteMessage checks the shape the host sends', () => {
  const msg = {
    n: 1,
    e: { x: 0, z: 0, heading: 0, swing: 0, travel: 0, digTime: 0, load: 0 },
    w: { x: 0, z: 0, facing: 0, stride: 0, walk: 0, headYaw: 0 },
    r: [],
    h: [],
    m: { t: [], s: [] },
    hue: null,
    reset: 0,
    spin: 0,
  };
  assert.ok(isSiteMessage(msg));
  assert.ok(isSiteMessage({ ...msg, full: true }));
  assert.ok(!isSiteMessage({ ...msg, full: 'yes' }));
  assert.ok(!isSiteMessage({ ...msg, e: { x: 0 } }));
  assert.ok(!isSiteMessage({ ...msg, m: { t: [] } }));
  assert.ok(!isSiteMessage(null));
  assert.ok(!isSiteMessage('site'));
});

test("foldMarks keeps every mark the host sent; marksToApply gives a guest the new ones, or all of them after a reset", () => {
  const caps = { t: 4, s: 2 };
  const mark = (i) => [i, 0, 0, 36, 34, 0];
  const msg = (reset, t, s = [], full = false) => ({ reset, full, m: { t, s } });
  const appliedFrom = (kept) => ({ epoch: kept.epoch, t: kept.total.t, s: kept.total.s });

  // A newcomer's first message has every mark; nothing is applied yet, so all of them go on.
  let kept = foldMarks(null, msg(1, [mark(1), mark(2)], [], true), caps);
  assert.deepEqual(marksToApply(null, kept), { restore: true, t: [mark(1), mark(2)], s: [] });
  let applied = appliedFrom(kept);
  assert.deepEqual(marksToApply(applied, kept), { restore: false, t: [], s: [] }, 'nothing new');

  // Two messages before the next frame (or while out of AR): both kept, and only those are new.
  kept = foldMarks(kept, msg(1, [mark(3)]), caps);
  kept = foldMarks(kept, msg(1, [mark(4)], [mark(9)]), caps);
  assert.deepEqual(marksToApply(applied, kept), { restore: false, t: [mark(3), mark(4)], s: [mark(9)] });
  applied = appliedFrom(kept);

  // More since the last frame than the slots hold: the oldest are gone anyway, so all again.
  for (let i = 5; i <= 9; i++) kept = foldMarks(kept, msg(1, [mark(i)]), caps);
  assert.deepEqual(kept.t, [mark(6), mark(7), mark(8), mark(9)]);
  assert.equal(kept.total.t, 9);
  assert.equal(marksToApply(applied, kept).restore, true);

  // A full message (someone joined) replaces them all; so does the host's reset, after which
  // it sends every mark it has since.
  const before = kept.epoch;
  kept = foldMarks(kept, msg(1, [mark(1)], [], true), caps);
  assert.ok(kept.epoch > before);
  assert.deepEqual(kept.t, [mark(1)]);
  kept = foldMarks(kept, msg(2, [mark(7)]), caps);
  assert.deepEqual([kept.t, kept.reset], [[mark(7)], 2]);
  assert.equal(marksToApply({ epoch: before, t: 9, s: 1 }, kept).restore, true, 'an older epoch');
});

test('easeTowards closes in on the target and wraps angles the short way', () => {
  let state = { x: 0, z: 0, heading: 3, swing: 0, travel: 0, speed: 0, turnRate: 0, swingRate: 0 };
  const target = { x: 100, z: -50, heading: -3, swing: 1, travel: 400 };
  for (let i = 0; i < 72; i++) state = easeTowards(state, target, 1 / 72);
  near(state.x, 100, 1);
  near(state.z, -50, 1);
  near(state.travel, 400, 4);
  near(state.swing, 1, 0.01);
  // From 3 to -3 is 0.28 rad through π, not 6 rad back through 0.
  assert.ok(state.heading > 3 || state.heading < -3, `heading went the short way: ${state.heading}`);
  assert.equal(state.speed, 0);
  // An infinite dt jumps there.
  const jumped = easeTowards({ x: 0, z: 0, heading: 3, swing: 0, travel: 0 }, target, Infinity);
  assert.deepEqual([jumped.x, jumped.z, jumped.travel], [100, -50, 400]);
  near(jumped.swing, 1, 1e-12, 'swing');
  near(Math.atan2(Math.sin(jumped.heading + 3), Math.cos(jumped.heading + 3)), 0, 1e-9, 'heading');
});
