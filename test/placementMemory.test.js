import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SITES,
  PLACEMENT_KEY,
  PlacementMemory,
  RESTORE_TIMEOUT_MS,
  nearestSite,
  parseRecord,
  poseOf,
  recordText,
  siteMoved,
} from '../src/placementMemory.js';

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
const TABLE_A = { x: 0.1, y: 0.75, z: -1.5, yaw: 0.4 };
const TABLE_B = { x: 2, y: 0.5, z: 1, yaw: 0 };
const saved = (storage) => parseRecord(storage.getItem(PLACEMENT_KEY));

beforeEach(() => {
  mock.method(console, 'info', () => {});
  mock.method(console, 'warn', () => {});
});

test('parseRecord reads its records (version 1 as a single site) and refuses anything else', () => {
  const v2 = recordText('a', [{ anchor: 'a', savedAt: null, usedAt: 5, state: { n: 1 } }]);
  assert.deepEqual(parseRecord(v2), { current: 'a', sites: [{ anchor: 'a', savedAt: null, usedAt: 5, state: { n: 1 } }] });
  const v1 = JSON.stringify({ v: 1, anchor: 'old', savedAt: '2026-10-05T00:00:00Z', state: { n: 2 } });
  assert.deepEqual(parseRecord(v1), { current: 'old', sites: [{ anchor: 'old', savedAt: '2026-10-05T00:00:00Z', usedAt: 0, state: { n: 2 } }] });
  for (const bad of [null, '', 'nonsense', '{}', JSON.stringify({ v: 3, sites: [] }), JSON.stringify({ v: 1, anchor: '', state: {} })]) {
    assert.equal(parseRecord(bad), null, String(bad));
  }
  // Broken sites inside a good record are dropped.
  assert.equal(parseRecord(JSON.stringify({ v: 2, current: 'a', sites: [{ anchor: 'a' }, null] })).sites.length, 0);
});

test('poseOf reads position and turn about +Y; siteMoved ignores jitter; nearestSite matches tables', () => {
  const half = 0.4 / 2;
  const pose = poseOf(new XRRigidTransform({ x: 1, y: 2, z: 3 }, { y: Math.sin(half), w: Math.cos(half) }));
  assert.ok(Math.abs(pose.yaw - 0.4) < 1e-12);
  assert.equal(siteMoved(TABLE_A, { ...TABLE_A, x: TABLE_A.x + 0.01 }), false);
  assert.equal(siteMoved(TABLE_A, { ...TABLE_A, x: TABLE_A.x + 0.2 }), true);
  assert.equal(siteMoved(TABLE_A, { ...TABLE_A, yaw: 1.4 }), true);
  const sites = [{ pose: TABLE_A }, { pose: TABLE_B }, { pose: null }];
  assert.equal(nearestSite(sites, { x: 0.2, y: 0.76, z: -1.45 }), sites[0]);
  assert.equal(nearestSite(sites, { x: 0.5, y: 0.75, z: -1.5 }), null, '40 cm off');
  assert.equal(nearestSite(sites, { x: 2, y: 0.8, z: 1 }), null, 'another height');
});

test('a site the user works on is anchored once and saved', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  assert.deepEqual(memory.locate(browser.frame(), null, 0), { pose: null, pending: false }); // nothing saved yet
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 1 }), 100);
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 1 }), 110); // while the first is being made: no second anchor
  await settle();
  assert.equal(browser.persistent.size, 1);
  const record = saved(storage);
  assert.equal(record.current, 'uuid-1');
  assert.deepEqual(record.sites.map((s) => [s.anchor, s.state]), [['uuid-1', { n: 1 }]]);
  assert.equal(memory.locate(browser.frame(), null, 200).pose.x, TABLE_A.x);
});

test('each table keeps its own site: leaving one saves it, coming back finds it as it was', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  let live = { on: 'A', n: 1 };
  memory.keep(browser.frame(), null, TABLE_A, () => live, 0);
  await settle();
  live = { on: 'A', n: 2 }; // changed since the last save

  // To table B: nothing kept there; leaving A saves it as it was left.
  assert.equal(memory.siteFor(TABLE_B), null);
  memory.select(null);
  assert.deepEqual(saved(storage).sites[0].state, { on: 'A', n: 2 });
  memory.keep(browser.frame(), null, TABLE_B, () => ({ on: 'B' }), 2000);
  await settle();
  assert.equal(browser.persistent.size, 2, 'A keeps its anchor');
  assert.equal(saved(storage).current, 'uuid-2', 'B is where the user is now');

  // Back to A: its site, with its state.
  const a = memory.siteFor({ ...TABLE_A, x: TABLE_A.x + 0.05 });
  assert.ok(a);
  assert.deepEqual(a.state, { on: 'A', n: 2 });
  memory.select(a);
  memory.keep(browser.frame(), null, TABLE_A, () => ({ on: 'A', n: 3 }), 4000);
  assert.equal(saved(storage).current, 'uuid-1');
  assert.deepEqual(saved(storage).sites.find((s) => s.anchor === 'uuid-2').state, { on: 'B' });
});

test('a later session restores every site, waits for the last one used, and offers each by table', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const first = new PlacementMemory(storage);
  first.start(browser.session(), 0);
  first.keep(browser.frame(), null, TABLE_A, () => ({ on: 'A' }), 0);
  await settle();
  first.select(null);
  first.keep(browser.frame(), null, TABLE_B, () => ({ on: 'B' }), 2000);
  await settle();
  first.end();

  const next = new PlacementMemory(storage);
  next.start(browser.session(), 10000);
  assert.equal(next.locate(browser.frame(), null, 10000).pending, true);
  await settle();
  const found = next.locate(browser.frame(), null, 10016);
  assert.equal(found.pending, false);
  assert.equal(found.pose.x, TABLE_B.x, 'the table the user was last on');
  assert.deepEqual(next.siteFor(TABLE_A).state, { on: 'A' });
  assert.deepEqual(next.siteFor(TABLE_B).state, { on: 'B' });
});

test('the same site, moved a little (the table outline changed), is anchored again and the old anchor freed', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 1 }), 0);
  await settle();
  memory.keep(browser.frame(), null, { ...TABLE_A, x: TABLE_A.x + 0.1 }, () => ({ n: 1 }), 2000);
  await settle();
  assert.deepEqual([...browser.persistent.keys()], ['uuid-2']);
  assert.equal(saved(storage).sites.length, 1);
  assert.equal(memory.sites.length, 1);
});

test(`at most ${MAX_SITES} sites are kept: the one used longest ago goes`, async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  for (let i = 0; i <= MAX_SITES; i++) {
    memory.select(null);
    memory.keep(browser.frame(), null, { x: i, y: 0.75, z: 0, yaw: 0 }, () => ({ table: i }), i * 2000);
    await settle();
  }
  assert.equal(browser.persistent.size, MAX_SITES);
  assert.deepEqual(saved(storage).sites.map((s) => s.state.table).sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(memory.siteFor({ x: 0, y: 0.75, z: 0 }), null);
});

test('saves at most once a second, and flush() writes the latest', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 1 }), 0);
  await settle();
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 2 }), 500);
  assert.deepEqual(saved(storage).sites[0].state, { n: 1 });
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 3 }), 1000);
  assert.deepEqual(saved(storage).sites[0].state, { n: 3 });
  memory.keep(browser.frame(), null, TABLE_A, () => ({ n: 4 }), 1200);
  memory.flush();
  assert.deepEqual(saved(storage).sites[0].state, { n: 4 });
});

test('without the anchors feature nothing is kept between sessions, but the session keeps its sites', () => {
  const browser = new Browser();
  const storage = new Storage();
  storage.setItem(PLACEMENT_KEY, recordText('uuid-9', [{ anchor: 'uuid-9', savedAt: null, usedAt: 0, state: { old: true } }]));
  browser.persistent.set('uuid-9', new XRRigidTransform({}, {}));
  const memory = new PlacementMemory(storage);
  memory.start(browser.session({ anchors: false }), 0);
  assert.equal(memory.locate(browser.frame(), null, 0).pending, false);
  memory.keep(browser.frame(), null, TABLE_A, () => ({ on: 'A' }), 0);
  memory.select(null);
  memory.keep(browser.frame(), null, TABLE_B, () => ({ on: 'B' }), 100);
  assert.deepEqual(memory.locate(browser.frame(), null, 200).pose, TABLE_B);
  assert.deepEqual(memory.siteFor(TABLE_A).state, { on: 'A' }, 'kept in the session');
  assert.equal(browser.persistent.size, 1, 'no anchor made');
  assert.deepEqual(saved(storage).sites[0].state, { old: true }, 'storage untouched');
});

test('a saved anchor that is gone, or never turns up, means starting afresh', async () => {
  const browser = new Browser();
  const storage = new Storage();
  storage.setItem(PLACEMENT_KEY, recordText('uuid-gone', [{ anchor: 'uuid-gone', savedAt: null, usedAt: 0, state: {} }]));
  const memory = new PlacementMemory(storage);
  memory.start(browser.session(), 0);
  assert.deepEqual(memory.locate(browser.frame(), null, 0), { pose: null, pending: false });

  // Restorable but never located (the room isn't recognised): give up after the timeout.
  browser.persistent.set('uuid-lost', new XRRigidTransform({}, {}));
  storage.setItem(PLACEMENT_KEY, recordText('uuid-lost', [{ anchor: 'uuid-lost', savedAt: null, usedAt: 0, state: {} }]));
  const lost = new PlacementMemory(storage);
  lost.start(browser.session(), 0);
  const frame = { createAnchor: () => Promise.reject(new Error('no')), getPose: () => null };
  await settle();
  assert.equal(lost.locate(frame, null, 100).pending, true);
  assert.deepEqual(lost.locate(frame, null, RESTORE_TIMEOUT_MS + 1), { pose: null, pending: false });
});

test('a site whose anchor turns up only after its table was chosen is carried on, not doubled', async () => {
  const browser = new Browser();
  const storage = new Storage();
  const first = new PlacementMemory(storage);
  first.start(browser.session(), 0);
  first.keep(browser.frame(), null, TABLE_A, () => ({ on: 'A' }), 0);
  await settle();
  first.end();

  const next = new PlacementMemory(storage);
  next.start(browser.session(), 0);
  await settle();
  // The app chose the table before the anchor was located: no site for it yet.
  next.select(null);
  next.locate(browser.frame(), null, 16); // now it is
  next.keep(browser.frame(), null, TABLE_A, () => ({ on: 'A', again: true }), 32);
  await settle();
  assert.equal(next.sites.length, 1);
  assert.equal(browser.persistent.size, 1);
});
