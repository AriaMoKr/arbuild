// Remembers the dig site between sessions: which table it's on, through a persistent
// spatial anchor where the site stands (turned the way the site faces), and what's on it
// (the excavator, the rocks, the worker: whatever state the app hands over), saved in
// localStorage next to the anchor's UUID.
//
// WebXR anchors: frame.createAnchor(pose, space) makes one; anchor.requestPersistentHandle()
// gives a UUID that session.restorePersistentAnchor(uuid) brings back in a later session;
// session.deletePersistentAnchor(uuid) frees it (Quest allows only a few per site, so the
// old one goes when a new one is made). The session must ask for the 'anchors' feature.
// Within a session, the site's own last pose stands in until the anchor exists, so a table
// that drops out for a while (the headset taken off) gets its state back when it returns.
//
// Logs '[memory] …' lines for the debug log.

import { wrapAngle } from './excavatorDrive.js';

export const PLACEMENT_KEY = 'tableCube.placement';
const RECORD_VERSION = 1;
export const RESTORE_TIMEOUT_MS = 4000; // stop waiting for the saved anchor after this long
const SAVE_EVERY_MS = 1000;
const RETRY_AFTER_MS = 10000; // after a failed anchor, wait this long before trying again
const MOVED_M = 0.05; // the site moved this far, or turned TURNED_RAD: anchor it again
const TURNED_RAD = 0.05;

/** A saved record from its text: { anchor, savedAt, state }, or null if it isn't a valid one. */
export function parseRecord(text) {
  try {
    const r = JSON.parse(text);
    if (r?.v !== RECORD_VERSION || typeof r.anchor !== 'string' || !r.anchor || typeof r.state !== 'object' || !r.state) return null;
    return { anchor: r.anchor, savedAt: typeof r.savedAt === 'string' ? r.savedAt : null, state: r.state };
  } catch {
    return null;
  }
}

export function recordText(anchor, state, savedAt) {
  return JSON.stringify({ v: RECORD_VERSION, anchor, savedAt, state });
}

/** Whether site pose `b` ({ x, y, z, yaw }) is far enough from `a` to need a new anchor. */
export function siteMoved(a, b) {
  return !a || Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > MOVED_M || Math.abs(wrapAngle(a.yaw - b.yaw)) > TURNED_RAD;
}

/** { x, y, z, yaw } of an XRRigidTransform: its position and its turn about +Y. */
export function poseOf(transform) {
  const { x, y, z } = transform.position;
  const q = transform.orientation;
  const yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)); // where it turns +Z
  return { x, y, z, yaw };
}

export class PlacementMemory {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.session = null;
  }

  /** A session started (at frame time `now`): load the saved record and ask for its anchor back. */
  start(session, now) {
    Object.assign(this, {
      session,
      startedAt: now,
      anchor: null, // the XRAnchor this session's site is remembered by
      uuid: null, // its persistent handle
      anchoredPose: null, // the site pose that anchor was made for
      sessionPose: null, // the last pose of a site the user chose, in this session
      creating: false,
      retryAt: -Infinity,
      restoring: false,
      latest: null,
      lastSaveAt: -Infinity,
      lastSavedState: null,
    });
    this.record = this._load();
    this.anchorsEnabled = Boolean(session.enabledFeatures?.includes('anchors')) && typeof session.restorePersistentAnchor === 'function';
    if (!this.record) return;
    if (!this.anchorsEnabled) {
      console.info('[memory] anchors are off in this session: the dig site starts afresh');
      this.record = null;
      return;
    }
    if (!session.persistentAnchors?.includes(this.record.anchor)) {
      console.info(`[memory] the saved dig site's anchor is gone (${this.record.anchor.slice(0, 8)}): starting afresh`);
      this.record = null;
      return;
    }
    this.restoring = true;
    const uuid = this.record.anchor;
    session
      .restorePersistentAnchor(uuid)
      .then((anchor) => {
        if (this.session !== session) return;
        this.anchor = anchor;
        this.uuid = uuid;
      })
      .catch((err) => {
        console.warn(`[memory] couldn't restore the saved anchor: ${err.message}`);
        if (this.session === session) this.restoring = false;
      });
  }

  /**
   * Each frame: where the remembered site is ({ x, y, z, yaw } in `refSpace`, or null),
   * and whether the saved one is still being looked for (`pending`: the app waits).
   */
  locate(frame, refSpace, now) {
    let pose = null;
    if (this.anchor) {
      try {
        const p = frame.getPose(this.anchor.anchorSpace, refSpace);
        if (p) pose = poseOf(p.transform);
      } catch {
        // the anchor was deleted
      }
    }
    if (this.restoring && (pose || now - this.startedAt > RESTORE_TIMEOUT_MS)) {
      this.restoring = false;
      if (pose) {
        this.anchoredPose = pose;
        console.info(`[memory] found the saved dig site${this.record.savedAt ? ` from ${this.record.savedAt}` : ''}`);
      } else {
        console.info('[memory] gave up waiting for the saved anchor: starting afresh');
        this.record = null;
      }
    }
    // The anchor stands for the site it was made for; if the user has since put the site
    // somewhere else, that place counts until the new anchor is made.
    if (pose && this.sessionPose && siteMoved(this.anchoredPose, this.sessionPose)) pose = null;
    return { pose: pose ?? this.sessionPose, pending: this.restoring };
  }

  /** The saved state to put back on the remembered table, once; null when there's none (left). */
  takeSavedState() {
    const state = this.record?.state ?? null;
    if (this.record) this.record = { ...this.record, state: null };
    return state;
  }

  /**
   * The user's dig site is at `pose` ({ x, y, z, yaw } in `refSpace`); `getState()`
   * describes what's on it: remember it. Anchors it again when it has moved, and saves
   * at most once a second.
   */
  keep(frame, refSpace, pose, getState, now) {
    this.sessionPose = pose;
    this.latest = getState;
    const canAnchor = this.anchorsEnabled && !this.creating && !this.restoring && now >= this.retryAt;
    if (canAnchor && siteMoved(this.anchoredPose, pose)) this._anchor(frame, refSpace, pose, now);
    if (now - this.lastSaveAt >= SAVE_EVERY_MS) {
      this.lastSaveAt = now;
      this._save(getState);
    }
  }

  /** Writes the latest state now (the session is ending or the page going away). */
  flush() {
    if (this.latest) this._save(this.latest);
  }

  /** The session ended: its anchors and poses are gone. */
  end() {
    this.flush();
    this.latest = null; // nothing more to save until the next session's site
    this.session = null;
    this.anchor = null;
    this.sessionPose = null;
    this.restoring = false;
  }

  /** For the debug log and tests. */
  snapshot() {
    return { anchor: this.uuid, anchorsEnabled: Boolean(this.anchorsEnabled), pending: Boolean(this.restoring), creating: Boolean(this.creating) };
  }

  // ---------- internals ----------

  _anchor(frame, refSpace, pose, now) {
    if (typeof frame.createAnchor !== 'function' || typeof XRRigidTransform === 'undefined') return;
    const session = this.session;
    this.creating = true;
    const half = pose.yaw / 2;
    let request;
    try {
      request = frame.createAnchor(new XRRigidTransform({ x: pose.x, y: pose.y, z: pose.z }, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }), refSpace);
    } catch (err) {
      request = Promise.reject(err);
    }
    request
      .then(async (anchor) => {
        const uuid = await anchor.requestPersistentHandle();
        if (this.session !== session) return;
        const old = this.uuid;
        this.anchor = anchor;
        this.uuid = uuid;
        this.anchoredPose = pose;
        if (old && old !== uuid) session.deletePersistentAnchor(old).catch(() => {});
        this.lastSavedState = null; // the record names the new anchor now
        if (this.latest) this._save(this.latest);
        console.info(`[memory] anchored the dig site (${uuid.slice(0, 8)})`);
      })
      .catch((err) => {
        console.warn(`[memory] couldn't anchor the dig site: ${err.message}`);
        this.retryAt = now + RETRY_AFTER_MS;
      })
      .finally(() => {
        this.creating = false;
      });
  }

  _save(getState) {
    if (!this.uuid) return; // nothing to find it by next time
    const state = getState();
    const text = JSON.stringify(state);
    if (text === this.lastSavedState) return;
    try {
      this.storage.setItem(PLACEMENT_KEY, recordText(this.uuid, state, new Date().toISOString()));
      if (this.lastSavedState === null) console.info('[memory] saved the dig site');
      this.lastSavedState = text;
    } catch (err) {
      console.warn(`[memory] couldn't save: ${err.message}`);
    }
  }

  _load() {
    try {
      return parseRecord(this.storage.getItem(PLACEMENT_KEY));
    } catch {
      return null; // storage blocked
    }
  }
}
