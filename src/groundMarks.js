import * as THREE from 'three';
import { outOfFrame } from './excavatorDrive.js';

// What the dig site leaves on the table in the diorama look: tyre tracks where the
// excavator drives, a dug patch where the bucket scoops and dirt where a rock lands. They
// are flat marks just above the table, in the model frame (design units), each kind one
// InstancedMesh with a fixed number of slots: when it's full, the oldest mark goes. Unused
// slots are scaled to nothing, so the count never changes and nothing new is uploaded in
// AR. The marks are part of the saved dig site (state()/restore()).

export const TRACK_STEP = 30; // units each wheel row rolls between tread marks
export const TRACK_CAPACITY = 400; // about 3 m of driving
export const SPILL_CAPACITY = 60;
const TRACK_WIDTH = 34; // the tyres' width

/**
 * The tread marks the wheels left between two drive states (src/excavatorDrive.js): each
 * side leaves one at its trailing wheel (the rear one going forwards) every TRACK_STEP of
 * that side's own rolling, which also covers turning on the spot. `carry` is how far each
 * side has rolled since its last mark. Returns { marks: [{ x, z, yaw }], carry }.
 * `wheels`: { halfTrack, axle } (the wheel rows' and axles' distance from the centre).
 */
export function treadMarks(before, after, carry, { halfTrack, axle }) {
  const marks = [];
  const next = { ...carry };
  for (const [side, sign] of [
    ['left', 1],
    ['right', -1],
  ]) {
    // The same rolling distance digSite's setDrive turns the wheels by.
    const rolled = (d) => d.travel - sign * halfTrack * d.heading;
    const moved = rolled(after) - rolled(before);
    next[side] += Math.abs(moved);
    if (next[side] < TRACK_STEP) continue;
    next[side] %= TRACK_STEP;
    const trailing = moved >= 0 ? axle : -axle; // the front is -X, so going forwards the rear wheel is at +X
    const at = outOfFrame({ x: trailing, z: sign * halfTrack }, after.heading);
    marks.push({ x: after.x + at.x, z: after.z + at.z, yaw: after.heading });
  }
  return { marks, carry: next };
}

/** A fresh `carry` for treadMarks. */
export const noTread = () => ({ left: 0, right: 0 });

export class GroundMarks {
  /** `size` is a mark's [length, width] unless add() gives its own; `y` its height. */
  constructor({ capacity, material, y, size = [1, 1], tinted = false }) {
    this.capacity = capacity;
    this.y = y;
    this.size = size;
    const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // flat, length along X
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false; // its bounds don't follow the marks
    this.mesh.renderOrder = -1; // under the contact shadows
    this.mesh.userData.ground = true; // flat on the table: not a solid part
    this.tinted = tinted;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this.reset();
  }

  /** Adds a mark { x, z, yaw, length?, width?, tone? } (tone 0..1 darkens a tinted kind). */
  add(mark) {
    const m = {
      x: mark.x,
      z: mark.z,
      yaw: mark.yaw ?? 0,
      length: mark.length ?? this.size[0],
      width: mark.width ?? this.size[1],
      tone: mark.tone ?? 0,
    };
    this.marks.push(m);
    if (this.marks.length > this.capacity) this.marks.shift();
    this._write(this.cursor, m);
    this.cursor = (this.cursor + 1) % this.capacity;
    this._dirty();
  }

  get count() {
    return this.marks.length;
  }

  /** The marks, oldest first, as plain numbers. */
  state() {
    return this.marks.map((m) => [round(m.x), round(m.z), round(m.yaw, 3), round(m.length), round(m.width), round(m.tone, 2)]);
  }

  /** Puts back what state() gave (whatever doesn't make sense is skipped). */
  restore(state) {
    this.reset();
    if (!Array.isArray(state)) return;
    for (const s of state.slice(-this.capacity)) {
      if (!Array.isArray(s) || !s.every(Number.isFinite)) continue;
      const [x, z, yaw, length, width, tone] = s;
      this.add({ x, z, yaw, length, width, tone });
    }
  }

  reset() {
    this.marks = [];
    this.cursor = 0;
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this.mesh.setMatrixAt(i, this._m);
      if (this.tinted) this.mesh.setColorAt(i, this._c.setRGB(1, 1, 1)); // makes instanceColor before shaders compile
    }
    this._dirty();
  }

  _write(i, m) {
    this._q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, m.yaw);
    this._m.compose(this._p.set(m.x, this.y, m.z), this._q, this._s.set(m.length, 1, m.width));
    this.mesh.setMatrixAt(i, this._m);
    if (this.tinted) {
      const k = 1 - 0.45 * m.tone;
      this.mesh.setColorAt(i, this._c.setRGB(k, k, k));
    }
  }

  _dirty() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Tread marks: bars across the track, cut out (alpha-tested), dark earth. */
export function trackMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x5a4130,
    map: canvasTexture(64, 32, (g, w, h) => {
      for (let x = 2; x < w; x += 10) g.fillRect(x, 3, 6, h - 6);
      g.fillRect(0, 0, w, 3);
      g.fillRect(0, h - 3, w, 3);
    }),
    alphaTest: 0.5,
    roughness: 1,
    polygonOffset: true, // flat on the table and the diorama's ground: draw in front of them
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
}

/** Dug or spilt earth: a soft, ragged blob, darker where dug (instance tint). */
export function spillMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x7a5a3c,
    map: canvasTexture(64, 64, (g, w, h) => {
      const gradient = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
      gradient.addColorStop(0.6, 'rgba(255,255,255,0.7)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gradient;
      g.beginPath();
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const r = (w / 2) * (0.7 + 0.3 * Math.abs(Math.sin(i * 2.7)));
        g.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      g.fill();
    }),
    transparent: true,
    depthWrite: false,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
}

/** A small canvas texture drawn in white by `draw(context, w, h)`; null without a DOM (node tests). */
function canvasTexture(w, h, draw) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  draw(g, w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
