import * as THREE from 'three';
import { outOfFrame } from './excavatorDrive.js';

// What the dig site leaves on the table in the diorama look: tyre tracks where the
// excavator drives, a dug patch where the bucket scoops, dirt where a rock lands, and
// heaps of earth where the bucket dumps. The marks are flat, just above the table, the
// heaps are mounds; all in the model frame (design units), each kind one InstancedMesh
// with a fixed number of slots (when the marks are full the oldest goes; heaps join the
// nearest). Unused slots are scaled to nothing, so the count never changes and nothing new
// is uploaded in AR. They're all part of the saved dig site (state()/restore()).

export const TRACK_STEP = 30; // units each wheel row rolls between tread marks
export const TRACK_CAPACITY = 800; // about 6 m of driving
export const SPILL_CAPACITY = 60;
export const HEAP_CAPACITY = 40;
export const HEAP_LOAD_RADIUS = 55; // units: the radius of a heap of one bucket load (2.75 cm at full size)
const HEAP_HEIGHT = 0.45; // of its radius
const HEAP_JOIN = 25; // earth dumped this close to a heap's edge joins it
const HEAP_BASE_Y = 0.8; // above the marks (0.3, 0.5), under the contact shadows (1)
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

/** The radius of a heap of `loads` bucket loads: its volume grows with the loads. */
export function heapRadius(loads) {
  return HEAP_LOAD_RADIUS * Math.cbrt(Math.max(loads, 0));
}

const UPRIGHT = new THREE.Quaternion();

export class Heaps {
  /** `geometry`: a mound of radius 1 and height 1 with a flat bottom at y = 0. */
  constructor({ geometry, material, capacity = HEAP_CAPACITY }) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.userData.ground = true;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this.reset();
  }

  /**
   * `loads` bucket loads of earth dropped at (x, z): the heap there grows (its centre moves
   * towards where the earth fell), or a new one starts. Returns the heap.
   */
  add(x, z, loads) {
    if (!(loads > 0)) return null;
    let heap = this._nearest(x, z, (h) => heapRadius(h.loads) + HEAP_JOIN);
    if (!heap && this.heaps.length >= this.capacity) heap = this._nearest(x, z, () => Infinity);
    if (heap) {
      const total = heap.loads + loads;
      heap.x += ((x - heap.x) * loads) / total;
      heap.z += ((z - heap.z) * loads) / total;
      heap.loads = total;
    } else {
      heap = { x, z, loads };
      this.heaps.push(heap);
    }
    this._sync();
    return heap;
  }

  /**
   * The bucket bites at (x, z): takes up to `most` loads from the heap there (within its
   * radius plus `slack`); returns what it took, 0 when there's no heap.
   */
  scoop(x, z, most = 1, slack = 30) {
    const heap = this._nearest(x, z, (h) => heapRadius(h.loads) + slack);
    if (!heap) return 0;
    const taken = Math.min(most, heap.loads);
    heap.loads -= taken;
    if (heap.loads < 0.05) this.heaps.splice(this.heaps.indexOf(heap), 1);
    this._sync();
    return taken;
  }

  /** Flattens the heaps whose centres are within `r` of (x, z) (the excavator drove through); returns them. */
  flatten(x, z, r) {
    const gone = this.heaps.filter((h) => Math.hypot(h.x - x, h.z - z) < r);
    if (gone.length) {
      this.heaps = this.heaps.filter((h) => !gone.includes(h));
      this._sync();
    }
    return gone;
  }

  /** How high the earth is at (x, z): the tallest heap there (a dome), or 0. */
  heightAt(x, z) {
    let height = 0;
    for (const h of this.heaps) {
      const r = heapRadius(h.loads);
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < r) height = Math.max(height, HEAP_HEIGHT * r * (1 - (d / r) ** 2));
    }
    return height;
  }

  /** The heaps as circles { x, z, r }, for the worker to walk round. */
  obstacles() {
    return this.heaps.map((h) => ({ x: h.x, z: h.z, r: heapRadius(h.loads) }));
  }

  get count() {
    return this.heaps.length;
  }

  /** All the earth in heaps, in bucket loads. */
  get loads() {
    return this.heaps.reduce((sum, h) => sum + h.loads, 0);
  }

  state() {
    return this.heaps.map((h) => [round(h.x), round(h.z), round(h.loads, 2)]);
  }

  /** Puts back what state() gave (whatever doesn't make sense is skipped). */
  restore(state) {
    this.heaps = [];
    if (Array.isArray(state)) {
      for (const s of state.slice(0, this.capacity)) {
        if (!Array.isArray(s) || s.length !== 3 || !s.every(Number.isFinite) || !(s[2] > 0)) continue;
        this.heaps.push({ x: s[0], z: s[1], loads: s[2] });
      }
    }
    this._sync();
  }

  reset() {
    this.heaps = [];
    this._sync();
  }

  _nearest(x, z, within) {
    let best = null;
    let bestDistance = Infinity;
    for (const h of this.heaps) {
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < within(h) && d < bestDistance) {
        best = h;
        bestDistance = d;
      }
    }
    return best;
  }

  _sync() {
    for (let i = 0; i < this.capacity; i++) {
      const h = this.heaps[i];
      if (h) {
        const r = heapRadius(h.loads);
        this._m.compose(this._p.set(h.x, HEAP_BASE_Y, h.z), UPRIGHT, this._s.set(r, HEAP_HEIGHT * r, r));
      } else {
        this._m.makeScale(0, 0, 0);
      }
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

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

/** Heaps of dumped earth: the diorama's dirt, mottled by the mound geometry's vertex colours. */
export function heapMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 1, flatShading: true, vertexColors: true });
}

/** The earth in the bucket. */
export function loadMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x7d5f40, roughness: 1, flatShading: true });
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
