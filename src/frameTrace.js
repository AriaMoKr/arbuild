// Records the first seconds of an AR session frame by frame, to tell a stall caused by
// the app (long app or render time) from one caused by the browser entering AR (a long
// gap between frames while the app itself was quick). Pure, so it runs under node --test.

export class FrameTrace {
  constructor({ durationMs = 3000, slowMs = 20, maxListed = 8 } = {}) {
    this.durationMs = durationMs;
    this.slowMs = slowMs;
    this.maxListed = maxListed;
    this.reset();
  }

  /** Start tracing a session that started at `now` (performance.now()). */
  start(now) {
    this.reset();
    this.startedAt = now;
    this.active = true;
  }

  reset() {
    this.active = false;
    this.startedAt = null;
    this.firstFrameAt = null;
    this.lastTime = null;
    this.frames = [];
  }

  /**
   * Record one XR frame: `time` is the rAF timestamp, `appMs` and `renderMs` how long the
   * app's per-frame work and renderer.render took. Returns the summary text once the
   * trace window has passed (once per session), otherwise null.
   */
  record(time, appMs, renderMs) {
    if (!this.active) return null;
    if (this.firstFrameAt === null) this.firstFrameAt = time;
    const gap = this.lastTime === null ? null : time - this.lastTime;
    this.lastTime = time;
    this.frames.push({ at: time - this.firstFrameAt, gap, appMs, renderMs });
    if (time - this.firstFrameAt < this.durationMs) return null;
    this.active = false;
    return this.summary();
  }

  summary() {
    const frames = this.frames;
    const first = this.startedAt === null || this.firstFrameAt === null ? '' : `first frame ${round(this.firstFrameAt - this.startedAt)} ms after the session started; `;
    const slow = frames
      .map((f, i) => ({ ...f, i }))
      .filter((f) => (f.gap ?? 0) > this.slowMs || f.appMs + f.renderMs > this.slowMs);
    const worstWork = frames.reduce((m, f) => Math.max(m, f.appMs + f.renderMs), 0);
    const listed = slow
      .slice(0, this.maxListed)
      .map((f) => `#${f.i + 1} at ${round(f.at)} ms: gap ${f.gap === null ? '-' : round(f.gap)} ms, app ${round(f.appMs, 1)} ms, render ${round(f.renderMs, 1)} ms`);
    const more = slow.length > this.maxListed ? `; …and ${slow.length - this.maxListed} more` : '';
    const seconds = round(this.durationMs / 1000, 1);
    return (
      `${first}${frames.length} frames in ${seconds} s, most app+render time in one frame ${round(worstWork, 1)} ms; ` +
      (slow.length ? `slow frames: ${listed.join('; ')}${more}` : 'no slow frames')
    );
  }
}

function round(value, digits = 0) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
