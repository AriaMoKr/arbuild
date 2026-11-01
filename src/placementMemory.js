// Remembers a dig site per table, between sessions: each one is a persistent spatial anchor
// where the site stands (turned the way the site faces) plus what's on it (the excavator,
// the rocks, the worker: whatever state the app hands over), saved in localStorage next
// to the anchor's UUID. The table the user was last on is where the site goes next time.
//
// WebXR anchors: frame.createAnchor(pose, space) makes one; anchor.requestPersistentHandle()
// gives a UUID that session.restorePersistentAnchor(uuid) brings back in a later session;
// session.deletePersistentAnchor(uuid) frees it. Quest allows only a few per site, so at
// most MAX_SITES are kept and the one used longest ago goes first. The session must ask
// for the 'anchors' feature. Without it, sites are still kept within the session (by their
// pose in the reference space), so a table that drops out for a while (the headset taken
// off) or that the user comes back to gets its state back.
//
// An anchor far away (a table in another room) may not be found from where the user
// stands, and on the Quest the far tables got a fresh site, and a fresh anchor, on every
// visit. So each site is also saved relative to the first site in the record (`rel`: its
// pose in that site's frame). Tables don't move, so once any one anchor is found, every
// other site's place follows from it (a derived pose), and a table whose own anchor is
// lost still gets its site back; working on it then makes it a fresh anchor there.
//
// Logs '[memory] …' lines for the debug log.

import { intoFrame, outOfFrame, wrapAngle } from './excavatorDrive.js';

export const PLACEMENT_KEY = 'tableCube.placement';
const RECORD_VERSION = 2;
export const MAX_SITES = 6; // Quest keeps 8 persistent anchors per site; leave some room
export const RESTORE_TIMEOUT_MS = 4000; // stop waiting for the last site's anchor after this long
const SAVE_EVERY_MS = 1000;
const RETRY_AFTER_MS = 10000; // after a failed anchor, wait this long before trying again
const MOVED_M = 0.05; // the site moved this far, or turned TURNED_RAD: anchor it again
const TURNED_RAD = 0.05;
const MATCH_ACROSS_M = 0.3; // a site belongs to the table whose top centre is this close
const MATCH_HEIGHT_M = 0.1;

/**
 * A saved record from its text: { current, sites: [{ anchor, savedAt, usedAt, state, rel }] },
 * or null if it isn't a valid one. `rel` ({ x, y, z, yaw }, the site's pose in the first
 * site's frame) is null when unknown. Version 1 (a single site) is read as a one-site record.
 */
export function parseRecord(text) {
  try {
    const r = JSON.parse(text);
    const valid = (s) => typeof s?.anchor === 'string' && s.anchor && typeof s.state === 'object' && s.state;
    const isPose = (p) => p && ['x', 'y', 'z', 'yaw'].every((k) => Number.isFinite(p[k]));
    const site = (s) => ({
      anchor: s.anchor,
      savedAt: typeof s.savedAt === 'string' ? s.savedAt : null,
      usedAt: Number.isFinite(s.usedAt) ? s.usedAt : 0,
      state: s.state,
      rel: isPose(s.rel) ? { x: s.rel.x, y: s.rel.y, z: s.rel.z, yaw: s.rel.yaw } : null,
    });
    if (r?.v === 1 && valid(r)) return { current: r.anchor, sites: [site(r)] };
    if (r?.v !== RECORD_VERSION || !Array.isArray(r.sites)) return null;
    const sites = r.sites.filter(valid).map(site);
    return { current: typeof r.current === 'string' ? r.current : null, sites };
  } catch {
    return null;
  }
}

export function recordText(current, sites) {
  return JSON.stringify({ v: RECORD_VERSION, current, sites });
}

/** Whether site pose `b` ({ x, y, z, yaw }) is far enough from `a` to need a new anchor. */
export function siteMoved(a, b) {
  return !a || Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > MOVED_M || Math.abs(wrapAngle(a.yaw - b.yaw)) > TURNED_RAD;
}

/** `pose` ({ x, y, z, yaw }) expressed in the frame of `frame` (another pose). */
export function relativePose(pose, frame) {
  const d = intoFrame({ x: pose.x - frame.x, z: pose.z - frame.z }, frame.yaw);
  return { x: d.x, y: pose.y - frame.y, z: d.z, yaw: wrapAngle(pose.yaw - frame.yaw) };
}

/** The pose `rel` (given in `frame`'s frame) back in the outer frame: the inverse of relativePose. */
export function composePose(frame, rel) {
  const d = outOfFrame({ x: rel.x, z: rel.z }, frame.yaw);
  return { x: frame.x + d.x, y: frame.y + rel.y, z: frame.z + d.z, yaw: wrapAngle(frame.yaw + rel.yaw) };
}

/** The frame in which `pose` is `rel`: composePose(frameFrom(pose, rel), rel) is `pose` again. */
export function frameFrom(pose, rel) {
  const yaw = wrapAngle(pose.yaw - rel.yaw);
  const d = outOfFrame({ x: rel.x, z: rel.z }, yaw);
  return { x: pose.x - d.x, y: pose.y - rel.y, z: pose.z - d.z, yaw };
}

const NO_OFFSET = { x: 0, y: 0, z: 0, yaw: 0 };

/** { x, y, z, yaw } of an XRRigidTransform: its position and its turn about +Y. */
export function poseOf(transform) {
  const { x, y, z } = transform.position;
  const q = transform.orientation;
  const yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)); // where it turns +Z
  return { x, y, z, yaw };
}

/** The site whose pose is nearest `point` ({ x, y, z }), within the table-matching distances, or null. */
export function nearestSite(sites, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const s of sites) {
    if (!s.pose) continue;
    const distance = Math.hypot(s.pose.x - point.x, s.pose.z - point.z);
    if (distance < MATCH_ACROSS_M && Math.abs(s.pose.y - point.y) < MATCH_HEIGHT_M && distance < bestDistance) {
      best = s;
      bestDistance = distance;
    }
  }
  return best;
}

export class PlacementMemory {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.session = null;
    this.sites = [];
    this.current = null;
    this.home = null;
    this.latest = null;
  }

  /** A session started (at frame time `now`): load the saved sites and ask for their anchors back. */
  start(session, now) {
    Object.assign(this, {
      session,
      startedAt: now,
      sites: [],
      current: null, // the site on the table the site is on now (null: a table with none yet)
      home: null, // the site the user last worked on: where the site goes when nothing is chosen yet
      waiting: null, // home's anchor, while it's being looked for
      lastSaveAt: -Infinity,
      lastSavedContent: null,
      localCount: 0,
    });
    this.anchorsEnabled = Boolean(session.enabledFeatures?.includes('anchors')) && typeof session.restorePersistentAnchor === 'function';
    const record = this._load();
    if (!record?.sites.length) return;
    if (!this.anchorsEnabled) {
      console.info('[memory] anchors are off in this session: the dig sites start afresh');
      return;
    }
    const known = new Set(session.persistentAnchors ?? []);
    const gone = record.sites.filter((s) => !known.has(s.anchor)).length;
    if (gone) console.info(`[memory] ${gone} saved dig site(s) lost their anchors`);
    for (const saved of record.sites.filter((s) => known.has(s.anchor))) {
      const site = this._site({ uuid: saved.anchor, state: saved.state, savedAt: saved.savedAt, usedAt: saved.usedAt, rel: saved.rel });
      if (saved.anchor === record.current) {
        this.home = site;
        this.waiting = site;
      }
      session
        .restorePersistentAnchor(saved.anchor)
        .then((anchor) => {
          if (this.session === session) site.anchor = anchor;
        })
        .catch((err) => {
          console.warn(`[memory] couldn't restore a saved anchor: ${err.message}`);
          if (this.session !== session) return;
          this.sites = this.sites.filter((s) => s !== site);
          this._rebase();
          if (this.waiting === site) this.waiting = null;
          if (this.home === site) this.home = null;
        });
    }
    this._rebase(); // the record's first site may be among the lost
  }

  /**
   * Each frame: where the site the user last worked on is ({ x, y, z, yaw } in
   * `refSpace`, or null), and whether its saved anchor is still being looked for
   * (`pending`: the app waits). Also updates every site's pose from its anchor.
   */
  locate(frame, refSpace, now) {
    for (const s of this.sites) {
      if (!s.anchor) continue;
      try {
        const p = frame.getPose(s.anchor.anchorSpace, refSpace);
        if (p) {
          s.pose = poseOf(p.transform);
          s.poseKind = 'anchor';
          s.anchoredPose ??= s.pose;
        }
      } catch {
        // the anchor was deleted
      }
    }
    this._derive();
    if (this.waiting && (this.waiting.pose || now - this.startedAt > RESTORE_TIMEOUT_MS)) {
      if (this.waiting.pose) {
        const how = this.waiting.poseKind === 'derived' ? ' (from another site\'s anchor)' : '';
        console.info(`[memory] found the saved dig site${this.waiting.savedAt ? ` from ${this.waiting.savedAt}` : ''}${how}`);
      } else {
        console.info('[memory] gave up waiting for the saved anchor: starting afresh');
        if (this.home === this.waiting) this.home = null;
      }
      this.waiting = null;
    }
    return { pose: this.home?.pose ?? null, pending: Boolean(this.waiting) };
  }

  /** The site kept for the table whose top centre is `point`, or null if it has none. */
  siteFor(point) {
    return nearestSite(this.sites, point);
  }

  /**
   * The site is now on the table `site` belongs to (null: a table without one yet). The
   * one it was on is saved first, as it was left.
   */
  select(site) {
    if (site === this.current) return;
    if (this.current) {
      this._save(); // captures it first
      this.current.getState = null;
    }
    this.current = site;
    if (site) site.usedAt = Date.now();
  }

  /**
   * The user works on the dig site at `pose` ({ x, y, z, yaw } in `refSpace`), and
   * `getState()` describes what's on it: remember it as this table's site, and as where to
   * go next time. Anchors it (again, when it moved) and saves at most once a second.
   */
  keep(frame, refSpace, pose, getState, now) {
    if (!this.current) {
      // A site whose anchor turned up after the table was chosen is this one: carry on with it.
      this.current = this.siteFor(pose) ?? this._site({});
      this.current.usedAt = Date.now();
    }
    const site = this.current;
    site.keptPose = pose;
    if (!site.anchor) {
      site.pose = pose;
      site.poseKind = 'kept';
    }
    site.getState = getState;
    this.home = site;
    const canAnchor = this.anchorsEnabled && !site.creating && now >= site.retryAt;
    if (canAnchor && (!site.uuid || siteMoved(site.anchoredPose, pose))) this._anchor(site, frame, refSpace, pose, now);
    if (now - this.lastSaveAt >= SAVE_EVERY_MS) {
      this.lastSaveAt = now;
      this._save();
    }
  }

  /** Writes the current site's latest state now (the session is ending or the page going away). */
  flush() {
    this._save();
  }

  /** The session ended: its anchors and poses are gone. */
  end() {
    this.flush();
    for (const s of this.sites) s.getState = null;
    this.session = null;
    this.sites = [];
    this.current = null;
    this.home = null;
    this.waiting = null;
  }

  /** For the debug log and tests. */
  snapshot() {
    return {
      anchor: this.current?.uuid ?? null,
      sites: this.sites.length,
      anchorsEnabled: Boolean(this.anchorsEnabled),
      pending: Boolean(this.waiting),
    };
  }

  // ---------- internals ----------

  _site({ uuid = null, state = null, savedAt = null, usedAt = 0, rel = null }) {
    const site = {
      id: uuid ?? `local-${++this.localCount}`,
      uuid,
      anchor: null,
      anchoredPose: null, // the pose its anchor was made for, or first found at
      pose: null, // where it is now
      poseKind: null, // 'anchor' (its anchor was found), 'kept' (the user's, this session) or 'derived' (from another site's anchor and `rel`)
      rel, // its pose in the first site's frame, or null
      keptPose: null,
      state, // what's on it, as last captured
      getState: null, // the live state while it's the current site
      savedAt,
      usedAt,
      creating: false,
      retryAt: -Infinity,
      announced: false,
    };
    this.sites.push(site);
    return site;
  }

  _capture(site) {
    if (site.getState) site.state = site.getState();
  }

  /** The reference site: the first one. Its own frame is what every `rel` is given in. */
  get _reference() {
    return this.sites[0] ?? null;
  }

  /** Whether a site's pose is its own (its anchor, or the user's this session) rather than derived. */
  _own(site) {
    return Boolean(site.pose) && (site.poseKind === 'anchor' || site.poseKind === 'kept');
  }

  /**
   * Gives every site without a pose of its own one derived from the reference frame, which
   * any site with its own pose and a `rel` fixes (tables don't move). Called every frame.
   */
  _derive() {
    const reference = this._reference;
    if (!reference) return;
    let frame = null;
    if (this._own(reference)) frame = reference.pose;
    else {
      const known = this.sites.find((s) => this._own(s) && s.rel);
      if (known) frame = frameFrom(known.pose, known.rel);
    }
    if (!frame) return;
    for (const s of this.sites) {
      if (this._own(s) || !s.rel) continue;
      s.pose = composePose(frame, s.rel);
      s.poseKind = 'derived';
    }
  }

  /** Works out `rel` for every site with its own pose, from the reference frame. */
  _relate() {
    const reference = this._reference;
    if (!reference?.pose) return;
    reference.rel = { ...NO_OFFSET };
    for (const s of this.sites) {
      if (s !== reference && this._own(s)) s.rel = relativePose(s.pose, reference.pose);
    }
  }

  /** The first site changed (one was lost or forgotten): re-express every `rel` in the new first site's frame. */
  _rebase() {
    const reference = this._reference;
    if (!reference || !reference.rel) return;
    const old = reference.rel;
    for (const s of this.sites) s.rel = s.rel ? relativePose(s.rel, old) : null;
  }

  _anchor(site, frame, refSpace, pose, now) {
    if (typeof frame.createAnchor !== 'function' || typeof XRRigidTransform === 'undefined') return;
    const session = this.session;
    site.creating = true;
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
        const old = site.uuid;
        site.anchor = anchor;
        site.uuid = uuid;
        site.id = uuid;
        site.anchoredPose = pose;
        site.announced = false;
        if (old && old !== uuid) session.deletePersistentAnchor(old).catch(() => {});
        this._forgetOldest();
        console.info(`[memory] anchored the dig site (${uuid.slice(0, 8)})`);
        this._save();
      })
      .catch((err) => {
        console.warn(`[memory] couldn't anchor the dig site: ${err.message}`);
        site.retryAt = now + RETRY_AFTER_MS;
      })
      .finally(() => {
        site.creating = false;
      });
  }

  /** Over MAX_SITES anchored sites: forget the one used longest ago (never the current one). */
  _forgetOldest() {
    const anchored = this.sites.filter((s) => s.uuid);
    if (anchored.length <= MAX_SITES) return;
    const oldest = anchored.filter((s) => s !== this.current).sort((a, b) => a.usedAt - b.usedAt)[0];
    this.sites = this.sites.filter((s) => s !== oldest);
    this._rebase();
    this.session?.deletePersistentAnchor(oldest.uuid).catch(() => {});
    console.info(`[memory] forgot the dig site used longest ago (${oldest.uuid.slice(0, 8)})`);
  }

  /** Saves every anchored site, when anything about them changed. */
  _save() {
    if (this.current) this._capture(this.current);
    this._relate();
    const anchored = this.sites.filter((s) => s.uuid && s.state);
    if (!anchored.length) return;
    const current = this.home?.uuid ?? null;
    const rel = (s) => (s.rel ? [round(s.rel.x), round(s.rel.y), round(s.rel.z), round(s.rel.yaw)] : null);
    const content = JSON.stringify([current, anchored.map((s) => [s.uuid, s.usedAt, s.state, rel(s)])]);
    if (content === this.lastSavedContent) return;
    if (this.current?.uuid) this.current.savedAt = new Date().toISOString();
    try {
      this.storage.setItem(PLACEMENT_KEY, recordText(current, anchored.map((s) => ({ anchor: s.uuid, savedAt: s.savedAt, usedAt: s.usedAt, state: s.state, rel: s.rel }))));
      this.lastSavedContent = content;
      if (this.current?.uuid && !this.current.announced) {
        this.current.announced = true;
        console.info('[memory] saved the dig site');
      }
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

function round(value) {
  return Math.round(value * 1000) / 1000;
}
