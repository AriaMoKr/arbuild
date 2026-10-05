import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIG_CYCLE_S, DIG_KEYS, createDigSite, digPose } from '../src/digSite.js';

const site = createDigSite({ shadowTexture: null }); // no DOM canvas in node

test('the dig cycle never takes the bucket below the table', () => {
  // Measured over the whole cycle. (The tilted rocks sit a few mm into the table on purpose.)
  assert.ok(site.armLowest > 0.001, `the arm's lowest point is ${(site.armLowest * 1000).toFixed(1)} mm`);
  assert.ok(site.lowest > -0.005, `lowest point ${(site.lowest * 1000).toFixed(1)} mm`);
});

test('the footprint circle and height cover the whole cycle, and stay table-sized', () => {
  assert.ok(site.radius > 0.2 && site.radius < 0.3, `radius ${site.radius}`);
  assert.ok(site.height > 0.15 && site.height < 0.25, `height ${site.height}`);
});

test('digPose loops smoothly and starts and ends at the modelled pose', () => {
  for (const t of [0, DIG_CYCLE_S, 2 * DIG_CYCLE_S, -DIG_CYCLE_S]) {
    const p = digPose(t);
    assert.ok(Math.abs(p.boom) + Math.abs(p.arm) + Math.abs(p.bucket) < 1e-9, `pose at ${t}`);
  }
  // No jumps: neighbouring samples differ by little.
  let previous = digPose(0);
  for (let i = 1; i <= 600; i++) {
    const p = digPose((i / 600) * DIG_CYCLE_S);
    const step = Math.abs(p.boom - previous.boom) + Math.abs(p.arm - previous.arm) + Math.abs(p.bucket - previous.bucket);
    assert.ok(step < 0.05, `jump of ${step} rad at sample ${i}`); // the fastest move is ~0.03 rad per 10 ms
    previous = p;
  }
});

test('digPose names each phase and reports joint speed for the hydraulics sound', () => {
  const phases = DIG_KEYS.slice(1).map((k) => k.phase);
  assert.deepEqual(phases, ['reach', 'scoop', 'lift', 'dump', 'return']);
  for (let i = 1; i < DIG_KEYS.length; i++) {
    const mid = (DIG_KEYS[i - 1].t + DIG_KEYS[i].t) / 2;
    assert.equal(digPose(mid).phase, DIG_KEYS[i].phase);
  }
  let max = 0;
  for (let i = 0; i < 600; i++) {
    const h = digPose((i / 600) * DIG_CYCLE_S).hydraulics;
    assert.ok(h >= 0 && h <= 1);
    max = Math.max(max, h);
  }
  assert.ok(max > 0.95, `fastest point should read about 1, got ${max}`);
  assert.ok(digPose(DIG_KEYS[1].t).hydraulics < 0.1, 'joints are nearly still at a key');
});

test('animate poses the arm by dig time, separately from the clock', () => {
  assert.equal(site.animate(2.0).phase, 'scoop');
  assert.equal(site.animate(2.0, 0.5).phase, 'reach'); // the clock runs on, the arm stays early in its cycle
  site.animate(0);
});

test('driving data: the excavator starts clear of the worker and the rocks, with room round its body', () => {
  // The body circle holds the wheels and the house however it turns, but not the arm.
  assert.ok(site.bodyRadius > 180 && site.bodyRadius < 240, `body radius ${site.bodyRadius} units`);
  assert.equal(site.obstacles.length, 2);
  for (const o of site.obstacles) {
    const gap = Math.hypot(site.home.x - o.x, site.home.z - o.z) - site.bodyRadius - o.r;
    assert.ok(gap > 20, `only ${gap.toFixed(0)} units between the excavator and an obstacle at home`);
  }
});

test('setDrive moves and turns the chassis, swings the house, and rolls the wheels', () => {
  site.setDrive({ x: 50, z: -20, heading: 0.5, swing: -1, travel: 104 });
  assert.deepEqual(site.excavator.position.toArray(), [50, 0, -20]);
  assert.equal(site.excavator.rotation.y, 0.5);
  assert.equal(site.house.rotation.y, -1);
  // The house holds the arm, so swinging carries the bucket round with it.
  let bucketInHouse = false;
  site.house.traverse((o) => {
    if (o.geometry?.parameters?.width === 130) bucketInHouse = true; // the bucket's floor plates
  });
  assert.ok(bucketInHouse);
  // Driving straight on (no turn), every wheel turns by distance / radius.
  site.setDrive({ ...site.home, swing: 0, travel: 104 });
  const wheels = site.excavator.children.filter((c) => c.isGroup && c !== site.house);
  assert.equal(wheels.length, 4);
  for (const w of wheels) assert.ok(Math.abs(w.rotation.z - 2) < 1e-9, `wheel turned ${w.rotation.z}`);
  site.setDrive({ ...site.home, swing: 0, travel: 0 });
});
