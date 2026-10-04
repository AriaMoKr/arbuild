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

test('animate poses the model without changing its footprint measurement', () => {
  const pose = site.animate(2.0);
  assert.equal(pose.phase, 'scoop');
  site.animate(0);
});
