// Finds tables in WebXR scene data (plane-detection / mesh-detection) and decides
// which one the dig site belongs on. Pure math on plain numbers: no three.js and no
// WebXR objects beyond what callers pass in, so it runs under `node --test`.
//
// Conventions this code relies on (see README "How it works"):
// - Matrices are column-major 4x4 arrays, exactly XRRigidTransform.matrix.
// - Plane polygons lie in planeSpace's XZ plane (y = 0). Quest/IWER repeat the first
//   vertex at the end; the spec doesn't say either way, so both forms are accepted.
// - The plane normal is planeSpace +Y, but its sign is runtime-specific (Quest points
//   it *down* for table tops), so "up" always comes from the reference space instead.

export const TABLE_LABELS = ['table', 'desk'];

/** True when a semanticLabel names a table ('desk' is the pre-2023 Quest label; labels may be CSV). */
export function isTableLabel(label) {
  if (!label) return false;
  return label
    .toLowerCase()
    .split(',')
    .some((part) => TABLE_LABELS.includes(part.trim()));
}

/** Apply a column-major 4x4 matrix to the point (x, y, z). */
export function transformPoint(m, x, y, z) {
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
  };
}

function column(m, i) {
  return { x: m[i * 4], y: m[i * 4 + 1], z: m[i * 4 + 2] };
}

/**
 * Rotation about reference-space +Y that lines an object up with the matrix's most
 * horizontal local axis. Only yaw is taken: plane frames can be upside down and
 * mesh frames can be Z-up, so copying the full rotation would tip the site over.
 */
export function yawFromMatrix(m) {
  // Prefer local X, then Z, then Y: the first one that is mostly horizontal.
  for (const i of [0, 2, 1]) {
    const axis = column(m, i);
    const horizontal = Math.hypot(axis.x, axis.z);
    if (horizontal > Math.abs(axis.y)) return Math.atan2(-axis.z, axis.x);
  }
  return 0;
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

/**
 * Area-weighted centroid of a polygon in the XZ plane.
 * Returns { x, z, area } or null for an empty polygon.
 */
export function polygonCentroid(points) {
  let n = points.length;
  if (n === 0) return null;
  if (n > 1 && samePoint(points[0], points[n - 1])) n--; // closed loop: drop the repeat

  let twiceArea = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const cross = p.x * q.z - q.x * p.z;
    twiceArea += cross;
    cx += (p.x + q.x) * cross;
    cz += (p.z + q.z) * cross;
  }

  if (Math.abs(twiceArea) < 1e-9) {
    // Degenerate (a line or a point): fall back to the vertex average.
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += points[i].x;
      sz += points[i].z;
    }
    return { x: sx / n, z: sz / n, area: 0 };
  }
  return { x: cx / (3 * twiceArea), z: cz / (3 * twiceArea), area: Math.abs(twiceArea) / 2 };
}

/** Width (along local X) and depth (along local Z) of a polygon's bounding box. */
export function polygonExtents(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  if (minX > maxX) return { width: 0, depth: 0 };
  return { width: maxX - minX, depth: maxZ - minZ };
}

/**
 * Table top from an XRPlane: its polygon (planeSpace points) and the column-major
 * planeSpace pose matrix in the reference space.
 * Returns { center: {x,y,z}, yaw, width, depth, area } or null when the plane isn't
 * a usable horizontal surface. `center` lies on the table surface.
 */
export function tableTopFromPlane(polygon, matrix) {
  if (!polygon || polygon.length < 3) return null;
  const normal = column(matrix, 1);
  if (Math.abs(normal.y) < 0.9) return null; // not horizontal (either sign is fine)

  const centroid = polygonCentroid(polygon);
  if (!centroid || centroid.area <= 0) return null;
  const { width, depth } = polygonExtents(polygon);
  return {
    center: transformPoint(matrix, centroid.x, 0, centroid.z),
    yaw: yawFromMatrix(matrix),
    width,
    depth,
    area: centroid.area,
  };
}

/**
 * Table top from an XRMesh volume: flat xyz vertex array (meshSpace) and the
 * column-major meshSpace pose matrix. The mesh's local axes differ between runtimes
 * (IWER's table box is Z-up), so everything is measured in the reference space:
 * the top is the highest point and the centre is the middle of the footprint,
 * measured along the table's own horizontal axes.
 */
export function tableTopFromMesh(vertices, matrix) {
  if (!vertices || vertices.length < 9) return null;
  const yaw = yawFromMatrix(matrix);
  // Unit vectors of the table's footprint frame in the reference space.
  const ux = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const uz = { x: Math.sin(yaw), z: Math.cos(yaw) };

  let maxY = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const p = transformPoint(matrix, vertices[i], vertices[i + 1], vertices[i + 2]);
    maxY = Math.max(maxY, p.y);
    const u = p.x * ux.x + p.z * ux.z;
    const v = p.x * uz.x + p.z * uz.z;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  const width = maxU - minU;
  const depth = maxV - minV;
  if (!(width > 0 && depth > 0)) return null;
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return {
    center: { x: cu * ux.x + cv * uz.x, y: maxY, z: cu * ux.z + cv * uz.z },
    yaw,
    width,
    depth,
    area: width * depth,
  };
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Half-angle of the region treated as "in front of you": inside Quest 3's ~±55° horizontal field of view. */
export const VIEW_HALF_ANGLE = (50 * Math.PI) / 180;

/**
 * Signed horizontal angle in radians (positive = to the right) from the viewer's
 * forward direction to `point`. `viewer` is { x, y, z, forward: { x, z } }.
 * Returns null when the direction is unknown, e.g. while looking straight down.
 */
export function bearingTo(point, viewer) {
  const f = viewer?.forward;
  if (!f) return null;
  const dx = point.x - viewer.x;
  const dz = point.z - viewer.z;
  if (Math.hypot(f.x, f.z) < 0.2 || Math.hypot(dx, dz) < 1e-6) return null;
  return Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz);
}

/**
 * Angle in radians between the viewer's 3D forward direction and the direction to
 * `point` (0 = dead ahead). Returns Infinity when it can't be computed.
 */
export function viewAngleTo(point, viewer) {
  const f = viewer?.forward;
  if (!f) return Infinity;
  const dx = point.x - viewer.x;
  const dy = point.y - viewer.y;
  const dz = point.z - viewer.z;
  const lengths = Math.hypot(f.x, f.y ?? 0, f.z) * Math.hypot(dx, dy, dz);
  if (lengths < 1e-9) return Infinity;
  const cos = (f.x * dx + (f.y ?? 0) * dy + f.z * dz) / lengths;
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * Quarter turn (0, π/2, π or 3π/2) to add to a table's `yaw` so that an object's front
 * (its +Z axis) faces the viewer as nearly as it can while staying square to the table
 * edges. Returns 0 when there's no viewer or they stand right over `center`.
 */
export function quarterTurnToward(viewer, center, yaw) {
  if (!viewer) return 0;
  const dx = viewer.x - center.x;
  const dz = viewer.z - center.z;
  if (Math.hypot(dx, dz) < 1e-6) return 0;
  const facing = Math.atan2(dx, dz); // the yaw that points +Z straight at the viewer
  const quarters = Math.round((facing - yaw) / (Math.PI / 2));
  return (((quarters % 4) + 4) % 4) * (Math.PI / 2);
}

/** `angle` rounded to a quarter turn, as 0, π/2, π or 3π/2. */
export function snapQuarterTurn(angle) {
  const quarters = Math.round(angle / (Math.PI / 2));
  return (((quarters % 4) + 4) % 4) * (Math.PI / 2);
}

/**
 * The candidate a remembered dig site stood on: the table whose top centre is nearest
 * to `point` ({ x, y, z }), within 30 cm horizontally and 10 cm in height (a little
 * looser than sameTable, since Space Setup can be redone between sessions), or null.
 */
export function findRemembered(candidates, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const distance = Math.hypot(c.top.center.x - point.x, c.top.center.z - point.z);
    if (distance < 0.3 && Math.abs(c.top.center.y - point.y) < 0.1 && distance < bestDistance) {
      best = c;
      bestDistance = distance;
    }
  }
  return best;
}

/** True when `point` is within VIEW_HALF_ANGLE of where the viewer is facing (horizontally). */
export function isInView(point, viewer) {
  const bearing = bearingTo(point, viewer);
  return bearing !== null && Math.abs(bearing) <= VIEW_HALF_ANGLE;
}

/** Candidates ordered nearest-first by horizontal distance to `viewer` (input order kept on ties or no viewer). */
export function sortByDistance(candidates, viewer) {
  if (!viewer) return [...candidates];
  return candidates
    .map((c, i) => ({ c, i, d: horizontalDistance(c.top.center, viewer) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((e) => e.c);
}

/** How much further away a table outside the view counts when picking one automatically (metres). */
export const OUT_OF_VIEW_PENALTY = 1.5;

/**
 * The table to pick automatically: the nearest one, where tables outside the view count
 * OUT_OF_VIEW_PENALTY further away. A table in front of the user wins over one beside or
 * behind them only when it's about as close, never one in another room. Without a viewer
 * the first candidate wins. Returns the candidate or null.
 */
export function pickTable(candidates, viewer) {
  if (candidates.length === 0) return null;
  if (!viewer) return candidates[0];
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = horizontalDistance(c.top.center, viewer) + (isInView(c.top.center, viewer) ? 0 : OUT_OF_VIEW_PENALTY);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** How long the locked table may be missing from the scene data before the lock is dropped (ms). */
export const DROPOUT_GRACE_MS = 1000;

/**
 * True when two table tops are the same real table: centres within 15 cm horizontally and
 * 10 cm in height. Used to recognise a table that comes back as a new XRPlane/XRMesh
 * object after a dropout (browsers create a new object for a plane that was gone).
 */
export function sameTable(a, b) {
  return Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z) < 0.15 && Math.abs(a.center.y - b.center.y) < 0.1;
}

/**
 * Keeps the site on one table. The lock follows the same XRPlane/XRMesh object (`key`),
 * so the site never jumps between tables of similar distance. `next()` cycles through
 * tables.
 *
 * The automatic pick (pickTable) is provisional: Quest delivers the room's tables over
 * the first frames, sometimes the far ones first, so while it stands the tracker picks
 * again whenever a table it hasn't seen before arrives. Once the user takes control
 * (`next()`, or `confirm()` when they slide or spin the site) the lock only changes if
 * its table goes away.
 *
 * Scene data can drop out for a frame or two (on the Quest a table vanished and came
 * back within a frame), so a locked table that goes missing keeps its lock, and the site
 * stays at its last known place, for up to DROPOUT_GRACE_MS. That needs `now` (the frame
 * time in ms); without it a missing table is dropped at once. A table that comes back as
 * a new object in the same place (sameTable) takes over the lock as if it never left.
 *
 * `lockId` changes only when a table is newly picked (automatically or by the user), not
 * when the lock moves to a returning table's new object, so callers can tell a real
 * change of table (reset the site's slide and spin) from a dropout. `takeRecovery()`
 * reports, once, a dropout that was ridden out: { missingMs, newObject }.
 *
 * Cycling counts outward from where the viewer stood when the table was picked, not
 * from where they stand now. Otherwise walking up to the site and pressing again would
 * bounce between the two nearest tables forever.
 *
 * A candidate is { key, top } where `key` is any identity-stable object
 * (XRPlane/XRMesh objects keep their identity across frames) and `top` comes from
 * tableTopFromPlane / tableTopFromMesh. `viewer` is { x, y, z, forward?: { x, z } }.
 * `reason` says why the current lock was made: 'first', 'tables changed', 'table lost'
 * or 'user'.
 */
export class TableTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.lockedKey = null;
    this.origin = null; // where the viewer stood when the lock was made; fixes the cycle order
    this.provisional = false;
    this.reason = null;
    this.lastLocked = null; // the locked candidate as last seen, used while its table is missing
    this.missingSince = null;
    this._recovery = null;
    this.lockId = this.lockId ?? 0; // keeps counting across resets, so ids are never reused
    this._seen = new Set(); // every table key seen since the automatic pick
  }

  /** Returns the candidate the site should stand on this frame, or null. */
  update(candidates, viewer, now) {
    let reason = 'first';
    if (this.lockedKey) {
      let locked = candidates.find((c) => c.key === this.lockedKey);
      let newObject = false;
      if (!locked && this.lastLocked) {
        // The same table back under a new object: move the lock over, it isn't a new table.
        locked = candidates.find((c) => sameTable(c.top, this.lastLocked.top));
        if (locked) {
          this.lockedKey = locked.key;
          this._seen.add(locked.key);
          newObject = true;
        }
      }
      if (locked) {
        if (this.missingSince !== null || newObject) {
          this._recovery = { missingMs: this.missingSince === null ? 0 : now - this.missingSince, newObject };
        }
        this.lastLocked = locked;
        this.missingSince = null;
        if (!(this.provisional && this._newTableArrived(candidates))) {
          if (!this.origin && viewer) this.origin = { x: viewer.x, z: viewer.z }; // no pose when the lock was made
          return locked;
        }
        reason = 'tables changed';
      } else {
        if (now !== undefined && this.lastLocked) {
          this.missingSince ??= now;
          if (now - this.missingSince < DROPOUT_GRACE_MS) return this.lastLocked; // a brief dropout: hold on
        }
        reason = 'table lost';
      }
      this.lockedKey = null;
    }
    const chosen = pickTable(candidates, viewer);
    if (!chosen) return null;
    this.lockedKey = chosen.key;
    this.lockId++;
    this.lastLocked = chosen;
    this.missingSince = null;
    this.origin = viewer ? { x: viewer.x, z: viewer.z } : null;
    this.provisional = true;
    this.reason = reason;
    for (const c of candidates) this._seen.add(c.key);
    return chosen;
  }

  /** A dropout the lock rode out since the last call, { missingMs, newObject }, or null. Reported once. */
  takeRecovery() {
    const recovery = this._recovery;
    this._recovery = null;
    return recovery;
  }

  /** The user took control (drove, swung or dug): keep this table even if more tables arrive. */
  confirm() {
    this.provisional = false;
  }

  /** Lock onto the next table, going outward from the lock origin and wrapping. Returns it, or null. */
  next(candidates, viewer) {
    if (candidates.length === 0) return null;
    const ordered = sortByDistance(candidates, this.origin ?? viewer);
    const current = ordered.findIndex((c) => c.key === this.lockedKey);
    const chosen = ordered[(current + 1) % ordered.length];
    this.lockedKey = chosen.key;
    this.lockId++;
    this.lastLocked = chosen;
    this.missingSince = null;
    this.provisional = false;
    this.reason = 'user';
    if (!this.origin && viewer) this.origin = { x: viewer.x, z: viewer.z };
    return chosen;
  }

  /**
   * Lock onto `candidate` as a firm choice (the remembered table), with `reason`, unless
   * it's already locked that way. Returns it.
   */
  lockTo(candidate, viewer, reason) {
    if (this.lockedKey === candidate.key && !this.provisional && this.reason === reason) return candidate;
    this.lockedKey = candidate.key;
    this.lockId++;
    this.lastLocked = candidate;
    this.missingSince = null;
    this.provisional = false;
    this.reason = reason;
    this.origin = viewer ? { x: viewer.x, z: viewer.z } : null;
    return candidate;
  }

  /** 0-based position of the locked table in the cycle order (outward from the lock origin), or -1. */
  indexOf(candidates, viewer) {
    return sortByDistance(candidates, this.origin ?? viewer).findIndex((c) => c.key === this.lockedKey);
  }

  /** A table that hasn't been seen since the automatic pick: a reason to pick again. */
  _newTableArrived(candidates) {
    return candidates.some((c) => !this._seen.has(c.key));
  }
}
