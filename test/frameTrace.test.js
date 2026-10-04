import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameTrace } from '../src/frameTrace.js';

/** Feeds frames at `intervalMs`, with optional overrides { frameIndex: { gap, appMs, renderMs } }. */
function run(trace, { frames, intervalMs = 11.1, startTime = 1000, special = {} }) {
  let time = startTime;
  let result = null;
  for (let i = 0; i < frames && result === null; i++) {
    const s = special[i] ?? {};
    if (i > 0) time += s.gap ?? intervalMs;
    result = trace.record(time, s.appMs ?? 1, s.renderMs ?? 2);
  }
  return result;
}

test('FrameTrace reports nothing until the window has passed, then once', () => {
  const trace = new FrameTrace({ durationMs: 100 });
  trace.start(900);
  let time = 1000;
  for (let i = 0; i < 9; i++, time += 11) assert.equal(trace.record(time, 1, 2), null);
  const summary = trace.record(time, 1, 2); // 99 ms after the first frame: still inside
  assert.equal(summary, null);
  assert.match(trace.record(time + 11, 1, 2), /^first frame 100 ms after the session started; 11 frames in 0\.1 s/);
  assert.equal(trace.record(time + 22, 1, 2), null); // only once per session
});

test('FrameTrace tells a browser stall (long gap, quick app) from slow app work', () => {
  const trace = new FrameTrace({ durationMs: 1000 });
  trace.start(0);
  const summary = run(trace, {
    frames: 200,
    startTime: 400,
    special: { 2: { gap: 88 }, 30: { renderMs: 35 } },
  });
  assert.match(summary, /^first frame 400 ms after the session started/);
  assert.match(summary, /#3 at \d+ ms: gap 88 ms, app 1 ms, render 2 ms/); // the browser's stall
  assert.match(summary, /#31 at \d+ ms: gap 11 ms, app 1 ms, render 35 ms/); // the app's own slow frame
  assert.match(summary, /most app\+render time in one frame 36 ms/);
});

test('FrameTrace lists at most maxListed slow frames', () => {
  const trace = new FrameTrace({ durationMs: 500, maxListed: 2 });
  trace.start(0);
  const special = {};
  for (let i = 1; i < 6; i++) special[i] = { gap: 40 };
  const summary = run(trace, { frames: 100, special });
  assert.match(summary, /slow frames: #2 .*; #3 [^;]*; …and 3 more$/);
});

test('FrameTrace with smooth frames says so, and ignores frames when not started', () => {
  const idle = new FrameTrace({ durationMs: 50 });
  assert.equal(idle.record(1, 1, 1), null);
  const trace = new FrameTrace({ durationMs: 50 });
  trace.start(0);
  assert.match(run(trace, { frames: 20 }), /no slow frames$/);
});
