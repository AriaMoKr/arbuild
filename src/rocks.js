import * as THREE from 'three';

// The rock pile, rock by rock. When the dig cycle starts a scoop, the bucket picks up the
// top rock near its teeth and draws it inside; when it has dumped, the rock falls out
// onto the table, or onto other rocks, under the bucket. So piles grow wherever the
// excavator dumps. Each rock casts its own soft contact shadow.
//
// Everything is in the dig site's model frame (design units, y up, the table top at
// y = 0), the frame the rocks' meshes live in when they're not in the bucket.

const SINK = 2; // rocks sit this far into whatever they rest on, so they look heavy
export const SCOOP_REACH = 90; // a rock this close to the teeth (horizontally) can be scooped
const GRAVITY = 19620; // units/s²: 9.81 m/s² at full size
const STACK_OVERLAP = 0.6; // rocks nearer than this share of their summed radii rest on each other
export const SHADOW_SCALE = 1.4; // a rock's shadow ellipse, relative to its footprint

/** A rock's footprint radius: half its horizontal diagonal. */
export function rockRadius(rock) {
  return 0.5 * Math.hypot(rock.w, rock.d);
}

/**
 * The surface `rock` would rest on at (x, z): the top of the highest resting rock under
 * it, or the table (0). Its centre then goes at that + h/2 - SINK.
 */
export function restBase(rock, x, z, rocks) {
  let base = 0;
  for (const o of rocks) {
    if (o === rock || o.state !== 'resting') continue;
    if (Math.hypot(o.x - x, o.z - z) < (rockRadius(o) + rockRadius(rock)) * STACK_OVERLAP) base = Math.max(base, o.y + o.h / 2);
  }
  return base;
}

/** The resting rock to scoop at `point` ({ x, z }): the highest one within reach, or null. */
export function rockToScoop(rocks, point, reach = SCOOP_REACH) {
  let best = null;
  for (const r of rocks) {
    if (r.state !== 'resting' || Math.hypot(r.x - point.x, r.z - point.z) > reach + rockRadius(r) / 2) continue;
    if (!best || r.y + r.h / 2 > best.y + best.h / 2) best = r;
  }
  return best;
}

const smooth = (f) => f * f * (3 - 2 * f);

/** The height of a rock mesh's lowest corner, in its parent's frame. */
function lowestCorner(rock) {
  let lowest = Infinity;
  const corner = new THREE.Vector3();
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corner.set((sx * rock.w) / 2, (sy * rock.h) / 2, (sz * rock.d) / 2).applyQuaternion(rock.mesh.quaternion);
        lowest = Math.min(lowest, rock.mesh.position.y + corner.y);
      }
    }
  }
  return lowest;
}

export class Rocks {
  /**
   * `model` is the group the rocks rest in; `rocks` are { mesh, w, h, d } with the meshes
   * already placed in it; `bucket` the group they ride in, `inside` the bucket-local point
   * a carried rock settles at. Shadows use `shadowMaterial` on a shared 1x1 plane.
   */
  constructor({ model, rocks, bucket, inside, shadowMaterial, shadowGeometry }) {
    this.model = model;
    this.bucket = bucket;
    this.inside = inside.clone();
    this.carried = null; // { rock, from, fromQuaternion }
    this.drops = 0; // counts dumps, to vary how dropped rocks land
    this.rocks = rocks.map((r) => {
      const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
      shadow.userData.shadow = true;
      model.add(shadow);
      return { ...r, shadow, state: 'resting', x: 0, y: 0, z: 0, fall: null };
    });
    for (const r of this.rocks) this._sync(r);
    this.initial = this.state();
  }

  /** Resting rocks as circles { x, z, r } the excavator mustn't drive into. */
  obstacles() {
    return this.rocks.filter((r) => r.state === 'resting').map((r) => ({ x: r.x, z: r.z, r: rockRadius(r) }));
  }

  /**
   * The dig cycle has started a scoop with the teeth at `teeth` ({ x, z }, model frame):
   * the highest rock within reach goes into the bucket. Returns whether one did.
   */
  scoop(teeth) {
    if (this.carried) return false;
    const rock = rockToScoop(this.rocks, teeth);
    if (!rock) return false;
    rock.state = 'carried';
    rock.shadow.visible = false;
    // It stays in the model frame while carry() draws it into the bucket, then rides in it.
    this.carried = { rock, from: rock.mesh.position.clone(), fromQuaternion: rock.mesh.quaternion.clone(), inBucket: false };
    this._settle(); // anything that rested on it falls
    return true;
  }

  /**
   * How far the scoop has got (0..1): the carried rock slides from where it lay into the
   * bucket, never dipping into the table on the way, and rides in the bucket from 1 on.
   */
  carry(progress) {
    if (!this.carried || this.carried.inBucket) return;
    const { rock, from, fromQuaternion } = this.carried;
    const f = smooth(Math.min(1, Math.max(0, progress)));
    // The inside of the bucket and its turn, in the model frame, as the arm is now.
    this.bucket.updateWorldMatrix(true, false);
    this.model.updateWorldMatrix(true, false);
    const toModel = new THREE.Matrix4().copy(this.model.matrixWorld).invert().multiply(this.bucket.matrixWorld);
    const inside = this.inside.clone().applyMatrix4(toModel);
    const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(toModel));
    rock.mesh.position.lerpVectors(from, inside, f);
    rock.mesh.quaternion.slerpQuaternions(fromQuaternion, turn, f);
    const lowest = lowestCorner(rock);
    if (lowest < -SINK) rock.mesh.position.y += -SINK - lowest;
    if (progress >= 1) {
      this.bucket.attach(rock.mesh);
      rock.mesh.position.copy(this.inside);
      rock.mesh.quaternion.identity();
      this.carried.inBucket = true;
    }
  }

  /**
   * The bucket has opened: the carried rock drops out and falls onto whatever is under
   * it, kept on the table by `area` ({ contains(x, z, r) -> { x, z } }, model frame).
   */
  dump(area) {
    if (!this.carried) return;
    const { rock } = this.carried;
    this.carried = null;
    this.model.attach(rock.mesh);
    // Land a little turned and tilted, differently each time.
    const n = ++this.drops;
    const yaw = (n * 2.39996) % (2 * Math.PI); // golden angle steps
    const tilt = (((n * 7) % 5) - 2) * 0.06;
    const end = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, -tilt / 2, 'YXZ'));
    const to = area.contains(rock.mesh.position.x, rock.mesh.position.z, rockRadius(rock));
    this._drop(rock, to, end);
  }

  /** Moves falling rocks on by `dt` seconds. */
  update(dt) {
    for (const r of this.rocks) {
      if (r.state !== 'falling') continue;
      const fall = r.fall;
      fall.v += GRAVITY * dt;
      const y = Math.max(fall.restY, r.mesh.position.y - fall.v * dt);
      const f = fall.height > 0 ? Math.min(1, (fall.startY - y) / fall.height) : 1;
      r.mesh.position.set(fall.from.x + (fall.to.x - fall.from.x) * f, y, fall.from.z + (fall.to.z - fall.from.z) * f);
      r.mesh.quaternion.slerpQuaternions(fall.fromQuaternion, fall.endQuaternion, f);
      if (y <= fall.restY) {
        r.state = 'resting';
        r.fall = null;
        this._sync(r);
      }
    }
  }

  /** Whether a rock is moving: in the bucket or falling. */
  get busy() {
    return this.rocks.some((r) => r.state !== 'resting');
  }

  /**
   * Where every rock is, as plain numbers: model-frame position and quaternion, or
   * `carried` for the one in the bucket. A falling rock is given where it will land.
   */
  state() {
    return this.rocks.map((r) => {
      if (r.state === 'carried') return { carried: true };
      const p = r.state === 'falling' ? { x: r.fall.to.x, y: r.fall.restY, z: r.fall.to.z } : r.mesh.position;
      const q = r.state === 'falling' ? r.fall.endQuaternion : r.mesh.quaternion;
      return { x: p.x, y: p.y, z: p.z, q: [q.x, q.y, q.z, q.w] };
    });
  }

  /** Puts the rocks back as state() described them. Returns false (changing nothing) if it doesn't fit. */
  restore(state) {
    if (!Array.isArray(state) || state.length !== this.rocks.length) return false;
    const valid = state.every((s) => s?.carried === true || (['x', 'y', 'z'].every((k) => Number.isFinite(s?.[k])) && s.q?.length === 4 && s.q.every(Number.isFinite)));
    if (!valid || state.filter((s) => s.carried).length > 1) return false;
    this.carried = null;
    this.rocks.forEach((r, i) => {
      const s = state[i];
      r.fall = null;
      if (s.carried) {
        this.bucket.add(r.mesh);
        r.mesh.position.copy(this.inside);
        r.mesh.quaternion.identity();
        r.state = 'carried';
        r.shadow.visible = false;
        this.carried = { rock: r, from: this.inside.clone(), fromQuaternion: new THREE.Quaternion(), inBucket: true };
        return;
      }
      this.model.add(r.mesh);
      r.mesh.position.set(s.x, s.y, s.z);
      r.mesh.quaternion.set(...s.q).normalize();
      r.state = 'resting';
      this._sync(r);
    });
    return true;
  }

  /** The pile as it was built. */
  reset() {
    this.restore(this.initial);
  }

  // ---------- internals ----------

  _drop(rock, to, endQuaternion) {
    const restY = restBase(rock, to.x, to.z, this.rocks) + rock.h / 2 - SINK;
    const startY = Math.max(restY, rock.mesh.position.y);
    rock.state = 'falling';
    rock.shadow.visible = false;
    rock.fall = {
      v: 0,
      from: { x: rock.mesh.position.x, z: rock.mesh.position.z },
      to,
      startY,
      restY,
      height: startY - restY,
      fromQuaternion: rock.mesh.quaternion.clone(),
      endQuaternion,
    };
    rock.mesh.position.y = startY;
  }

  /** Rocks left resting on nothing (the one under them was scooped) fall. */
  _settle() {
    const resting = this.rocks.filter((r) => r.state === 'resting').sort((a, b) => a.y - a.h / 2 - (b.y - b.h / 2));
    for (const r of resting) {
      // Rocks are built a little sunk into what's under them, so only a real gap counts.
      if (r.y - r.h / 2 + SINK > restBase(r, r.x, r.z, this.rocks) + 1) this._drop(r, { x: r.x, z: r.z }, r.mesh.quaternion.clone());
    }
  }

  /** Copies a resting rock's mesh pose into its numbers and puts its shadow under it. */
  _sync(r) {
    r.x = r.mesh.position.x;
    r.y = r.mesh.position.y;
    r.z = r.mesh.position.z;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(r.mesh.quaternion);
    const yaw = Math.atan2(forward.x, forward.z);
    r.shadow.position.set(r.x, 1, r.z);
    r.shadow.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
    r.shadow.scale.set(r.w * SHADOW_SCALE, r.d * SHADOW_SCALE, 1);
    r.shadow.visible = true;
  }
}
