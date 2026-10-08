import * as THREE from 'three';

// The dig site's sound, made with WebAudio (no sound files): a diesel hum that chugs, a
// hydraulic hiss and whine while the arm moves, and a clatter of rocks on each scoop and
// dump. It comes from the excavator, positioned in 3D, so it pans and fades with your
// head. Browsers only start audio from a user gesture, so start() is called from the
// Enter AR click. It's off until someone turns it on (the menu's Sound button), and that
// choice is remembered; while off, the graph runs at zero volume, so turning it on in AR
// doesn't depend on the trigger counting as a user gesture.

const MUTE_KEY = 'tableCube.soundMuted';
const CLATTER_PHASES = new Set(['scoop', 'dump']); // the bucket bites, then empties

export class SiteSound {
  /** `emitter`: the object the sound comes from; `camera`: where the listener goes. */
  constructor({ emitter, camera }) {
    this.emitter = emitter;
    this.camera = camera;
    this.muted = loadMuted();
    this.context = null;
    this._phase = null;
  }

  /** The sound now comes from `emitter` (the dig site's look was switched). */
  setEmitter(emitter) {
    this.emitter = emitter;
    if (this.positional) emitter.add(this.positional);
  }

  /** Builds the audio graph on first use and (re)starts it. Call from a user gesture. */
  start() {
    if (!this.context) this._build();
    this.context.resume().catch(() => {});
    this._applyMute();
  }

  /** Session over: let the audio thread sleep. */
  stop() {
    this._phase = null;
    this.context?.suspend().catch(() => {});
  }

  get state() {
    return this.context?.state ?? 'not started';
  }

  toggleMuted() {
    this.muted = !this.muted;
    saveMuted(this.muted);
    this._applyMute();
    console.info(`[sound] ${this.muted ? 'off' : 'on'}`);
    return this.muted;
  }

  /**
   * Called each frame with the dig pose (digPose) and whether the site is shown:
   * hydraulics follow the joint speed, and a clatter starts at each scoop and dump.
   */
  update(pose, visible) {
    if (!this.context || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    const level = visible && !this.muted ? 1 : 0;
    this.master.gain.setTargetAtTime(level, now, 0.08);
    if (!pose) return;
    const h = pose.hydraulics;
    this.hissGain.gain.setTargetAtTime(0.09 * h, now, 0.05);
    this.whineGain.gain.setTargetAtTime(0.025 * h, now, 0.05);
    this.engine.frequency.setTargetAtTime(44 + 10 * h, now, 0.2); // works harder under load
    if (pose.phase !== this._phase) {
      if (this._phase !== null && CLATTER_PHASES.has(pose.phase) && visible && !this.muted) this._clatter(now);
      this._phase = pose.phase;
    }
  }

  // ---------- internals ----------

  _build() {
    const listener = new THREE.AudioListener();
    this.camera.add(listener);
    const ctx = listener.context;
    this.context = ctx;

    this.positional = new THREE.PositionalAudio(listener);
    this.positional.setRefDistance(0.35); // the site is small and close: full volume within ~35 cm
    this.positional.setRolloffFactor(1.2);
    this.emitter.add(this.positional);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.positional.setNodeSource(this.master);

    // Diesel hum: a low sawtooth plus its octave, low-passed, with a fast chug on the volume.
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 240;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.16;
    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine.frequency.value = 44;
    const octave = ctx.createOscillator();
    octave.type = 'square';
    octave.frequency.value = 88.6;
    const octaveGain = ctx.createGain();
    octaveGain.gain.value = 0.25;
    const chug = ctx.createOscillator();
    chug.frequency.value = 7.5;
    const chugDepth = ctx.createGain();
    chugDepth.gain.value = 0.05;
    this.engine.connect(engineFilter);
    octave.connect(octaveGain).connect(engineFilter);
    engineFilter.connect(engineGain).connect(this.master);
    chug.connect(chugDepth).connect(engineGain.gain);

    // Hydraulics: band-passed noise (the hiss) and a quiet whine, both silent until the arm moves.
    this.noise = makeNoise(ctx);
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1100;
    hissFilter.Q.value = 2.5;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    hiss.connect(hissFilter).connect(this.hissGain).connect(this.master);
    const whine = ctx.createOscillator();
    whine.frequency.value = 470;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    whine.connect(this.whineGain).connect(this.master);

    for (const source of [this.engine, octave, chug, hiss, whine]) source.start();
  }

  /** A handful of short, bright noise clicks over a third of a second: rocks knocking together. */
  _clatter(now) {
    const ctx = this.context;
    for (let i = 0; i < 9; i++) {
      const at = now + Math.random() * 0.35;
      const grain = ctx.createBufferSource();
      grain.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1500 + Math.random() * 2500;
      filter.Q.value = 4;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0.35 * (0.5 + Math.random() * 0.5), at);
      envelope.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
      grain.connect(filter).connect(envelope).connect(this.master);
      grain.start(at, Math.random() * 0.9, 0.08);
    }
  }

  _applyMute() {
    if (!this.context) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.context.currentTime, 0.05);
  }
}

function makeNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // one second of white noise
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function loadMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) !== '0'; // off unless it was turned on
  } catch {
    return true;
  }
}

function saveMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // storage blocked: the setting just isn't remembered
  }
}
