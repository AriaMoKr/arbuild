import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PLACEMENT_KEY, PlacementMemory, RESTORE_TIMEOUT_MS, parseRecord, poseOf, recordText, siteMoved } from '../src/placementMemory.js';

// Fakes of the WebXR pieces the memory uses: anchors that sit where they were made,
// persistent handles kept by the fake browser across "sessions", and localStorage.

globalThis.XRRigidTransform = class {
  constructor(position, orientation) {
    this.position = { x: 0, y: 0, z: 0, ...position };
    this.orientation = { x: 0, y: 0, z: 0, w: 1, ...orientation };
  }
};

class Storage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
}

class Browser {
  constructor() {
    this.persistent = new Map(); // uuid -> transform
    this.next = 1;
  }
  session({ anchors = true } = {}) {
    const browser = this;
    return {
      enabledFeatures: anchors ? ['anchors'] : [],
      get persistentAnchors() {
        return [...browser.persistent.keys()];
      },
      restorePersistentAnchor(uuid) {
        return browser.persistent.has(uuid) ? Promise.resolve(browser.anchor(browser.persistent.get(uuid), uuid)) : Promise.reject(new Error('not found'));
      },
      deletePersistentAnchor(uuid) {
        browser.persistent.delete(uuid);
        return Promise.resolve();
      },
    };
  }
  anchor(transform, uuid = null) {
    const browser = this;
    return {
      anchorSpace: { transform },
      requestPersistentHandle() {
        uuid ??= `uuid-${browser.next++}`;
        browser.persistent.set(uuid, transform);
        return Promise.resolve(uuid);
      },
    };
  }
  frame() {
    return {
      createAnchor: (transform) => Promise.resolve(this.anchor(transform)),
      getPose: (space) => ({ transform: space.transform }),
    };
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const POSE = { x: 0.1, y: 0.75, z: -1.5, yaw: 0.4 };
const STATE = { excavator: { x: 10 }, rocks: [] };

beforeEach(() => {
  mock.method(console, 'info', () => {});
  mock.method(console, 'warn', () => {});
});

test('parseRecord accepts its own records and refuses anything else', () => {
  const text = recordText('abc', STATE, '2026-10-05T00:00:00Z');
  assert.deepEqual(parseRecord(text), { anchor: 'abc', savedAt: '2026-10-05T00:00:00Z', state: STATE });
  for (const bad of [null, '', 'nonsense', '{}', JSON.stringify({ v: 2, anchor: 'a', state: {} }), JSON.stringify({ v: 1, anchor: '', state: {} })]) {
    assert.equal(parseRecord(bad), null, String(bad));
  }
});

test('poseOf reads position and turn about +Y; siteMoved ignores jitter', () => {
  const half = 0.4 / 2;
  const pose = poseOf(new XRRigidTransform({ x: 1, y: 2, z: 3 }, { y: Math.sin(half), w: Math.cos(half) }));
  assert.ok(Math.abs(pose.yaw - 0.4) < 1e-12);
  assert.equal(pose.x, 1);
  assert.equal(siteMoved(POSE, { ...POSE, x: POSE.x + 0.01 }), false);
  assert.equal(siteMoved(POSE, { ...POSE, x: POSE.x + 0.2 }), true);
  assert.equal(siteMoved(POSE, { ...POSE, yaw: POSE.yaw + 1 }), true);
  assert.equal(siteMoved(null, POSE), true);
});

test('the chosen site is anchored once and saved; a later session finds it and gets the state back once', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  assert.deepEqual(memory.locate(browser.frame(), null, 0), { pose: null, pending: false }); // nothing saved yet

  memory.keep(browser.frame(), null, POSE, () => STATE, 100);
  memory.keep(browser.frame(), null, POSE, () => STATE, 110); // while the first is being made: no second anchor
  await settle();
  assert.equal(browser.persistent.size, 1);
  const record = parseRecord(storage.getItem(PLACEMENT_KEY));
  assert.equal(record.anchor, [...browser.persistent.keys()][0]);
  assert.deepEqual(record.state, STATE);

  // In this session the site's own pose stands in, and is where the anchor is.
  const here = memory.locate(browser.frame(), null, 200).pose;
  assert.ok(Math.abs(here.yaw - POSE.yaw) < 1e-9 && Math.abs(here.x - POSE.x) < 1e-9);
  memory.end();

  // Next session: wait for the anchor, then the saved state comes back, once.
  const next = new PlacementMemory(storage);
  next.start(browser.session(), 1000);
  assert.equal(next.locate(browser.frame(), null, 1000).pending, true);
  await settle();
  const found = next.locate(browser.frame(), null, 1016);
  assert.equal(found.pending, false);
  assert.ok(Math.abs(found.pose.x - POSE.x) < 1e-9 && Math.abs(found.pose.yaw - POSE.yaw) < 1e-9);
  assert.deepEqual(next.takeSavedState(), STATE);
  assert.equal(next.takeSavedState(), null);
});

test('moving the site to another table anchors it again and frees the old anchor', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  memory.keep(browser.frame(), null, POSE, () => STATE, 0);
  await settle();
  const first = [...browser.persistent.keys()][0];
  const elsewhere = { x: 2, y: 0.5, z: 1, yaw: 0 };
  memory.keep(browser.frame(), null, elsewhere, () => ({ moved: true }), 2000);
  // Until the new anchor exists, the new place is what counts.
  assert.equal(memory.locate(browser.frame(), null, 2000).pose.x, 2);
  await settle();
  assert.deepEqual([...browser.persistent.keys()], ['uuid-2']);
  assert.notEqual(first, 'uuid-2');
  assert.equal(parseRecord(storage.getItem(PLACEMENT_KEY)).anchor, 'uuid-2');
  assert.deepEqual(parseRecord(storage.getItem(PLACEMENT_KEY)).state, { moved: true });
});

test('saves at most once a second, and flush() writes the latest', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  memory.keep(browser.frame(), null, POSE, () => ({ n: 1 }), 0);
  await settle();
  memory.keep(browser.frame(), null, POSE, () => ({ n: 2 }), 500);
  assert.deepEqual(parseRecord(storage.getItem(PLACEMENT_KEY)).state, { n: 1 });
  memory.keep(browser.frame(), null, POSE, () => ({ n: 3 }), 1000);
  assert.deepEqual(parseRecord(storage.getItem(PLACEMENT_KEY)).state, { n: 3 });
  memory.keep(browser.frame(), null, POSE, () => ({ n: 4 }), 1200);
  memory.flush();
  assert.deepEqual(parseRecord(storage.getItem(PLACEMENT_KEY)).state, { n: 4 });
});

test('without the anchors feature nothing is kept between sessions, but the session still remembers', () => {
  const browser = new Browser();
  const storage = new Storage();
  storage.setItem(PLACEMENT_KEY, recordText('uuid-9', STATE, null));
  browser.persistent.set('uuid-9', new XRRigidTransform({}, {}));
  const memory = new PlacementMemory(storage);
  memory.start(browser.session({ anchors: false }), 0);
  assert.equal(memory.locate(browser.frame(), null, 0).pending, false);
  assert.equal(memory.takeSavedState(), null);
  memory.keep(browser.frame(), null, POSE, () => STATE, 0);
  assert.deepEqual(memory.locate(browser.frame(), null, 10).pose, POSE);
  assert.equal(browser.persistent.size, 1, 'no anchor made');
});

test('a saved anchor that is gone, or never turns up, means starting afresh', async () => {
  const browser = new Browser();
  const storage = new Storage();
  storage.setItem(PLACEMENT_KEY, recordText('uuid-gone', STATE, null));
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  assert.equal(memory.locate(browser.frame(), null, 0).pending, false);
  assert.equal(memory.takeSavedState(), null);

  // Restorable but never located (the room isn't recognised): give up after the timeout.
  browser.persistent.set('uuid-lost', new XRRigidTransform({}, {}));
  storage.setItem(PLACEMENT_KEY, recordText('uuid-lost', STATE, null));
  const lost = new PlacementMemory(storage);
  lost.start(browser.session(), 0);
  const frame = { createAnchor: () => Promise.reject(new Error('no')), getPose: () => null };
  await settle();
  assert.equal(lost.locate(frame, null, 100).pending, true);
  assert.equal(lost.locate(frame, null, RESTORE_TIMEOUT_MS + 1).pending, false);
  assert.equal(lost.takeSavedState(), null);
});
