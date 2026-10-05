import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Rocks, SCOOP_REACH, restBase, rockRadius, rockToScoop } from '../src/rocks.js';

/** A small pile like the dig site's: three rocks on the table, one resting on the first. */
function pile() {
  const model = new THREE.Group();
  const bucket = new THREE.Group();
  bucket.position.set(0, 200, 0);
  model.add(bucket);
  const make = (x, y, z, w, h, d) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
    mesh.position.set(x, y, z);
    model.add(mesh);
    return { mesh, w, h, d };
  };
  const list = [make(0, 18, 0, 60, 40, 50), make(200, 13, 0, 40, 30, 40), make(-300, 13, 100, 40, 30, 40), make(5, 48, 5, 30, 26, 30)];
  const rocks = new Rocks({
    model,
    rocks: list,
    bucket,
    inside: new THREE.Vector3(-65, -40, 0),
    shadowMaterial: new THREE.MeshBasicMaterial(),
    shadowGeometry: new THREE.PlaneGeometry(1, 1),
  });
  return { model, bucket, rocks };
}

const anywhere = { contains: (x, z) => ({ x, z }) };
const fallFor = (rocks, seconds) => {
  for (let i = 0; i < seconds * 72; i++) rocks.update(1 / 72);
};

test('rockToScoop takes the highest rock within reach, or none', () => {
  const { rocks } = pile();
  assert.equal(rockToScoop(rocks.rocks, { x: 10, z: 0 }), rocks.rocks[3]); // the one on top
  assert.equal(rockToScoop(rocks.rocks, { x: 200 + SCOOP_REACH, z: 0 }), rocks.rocks[1]);
  assert.equal(rockToScoop(rocks.rocks, { x: 1000, z: 1000 }), null);
});

test('restBase: a rock rests on the highest rock under it, or on the table', () => {
  const { rocks } = pile();
  const [big, , , top] = rocks.rocks;
  assert.equal(restBase(top, big.x, big.z, rocks.rocks), big.y + big.h / 2);
  assert.equal(restBase(top, 600, 600, rocks.rocks), 0);
  assert.ok(rockRadius(big) > 30);
});

test('a scoop picks up the top rock into the bucket, and dumping drops it where the bucket is', () => {
  const { rocks, bucket } = pile();
  const top = rocks.rocks[3];
  assert.ok(rocks.scoop({ x: 0, z: 0 }));
  assert.equal(top.state, 'carried');
  assert.equal(rocks.obstacles().length, 3, 'a carried rock is no obstacle');
  rocks.carry(0.5);
  assert.notEqual(top.mesh.parent, bucket, 'on its way in');
  rocks.carry(1);
  assert.equal(top.mesh.parent, bucket);
  assert.ok(top.mesh.position.distanceTo(new THREE.Vector3(-65, -40, 0)) < 1e-9, 'drawn right into the bucket');
  assert.equal(rocks.scoop({ x: 200, z: 0 }), false, 'one rock at a time');

  bucket.position.set(500, 200, -200); // the cab swung round
  bucket.updateMatrixWorld(true);
  rocks.dump(anywhere);
  assert.equal(top.state, 'falling');
  fallFor(rocks, 1);
  assert.equal(top.state, 'resting');
  assert.ok(Math.abs(top.x - 435) < 1e-6 && Math.abs(top.z + 200) < 1e-6, `landed at ${top.x}, ${top.z}`);
  assert.ok(Math.abs(top.y - (top.h / 2 - 2)) < 1e-6, 'on the table, sunk in a little');
  assert.equal(rocks.obstacles().length, 4);
});

test('a dumped rock lands on top of a rock already there, and the table edge keeps it on', () => {
  const { rocks, bucket } = pile();
  const small = rocks.rocks[1];
  rocks.scoop({ x: 200, z: 0 });
  rocks.carry(1);
  bucket.position.set(65, 300, 0); // its inside right over the big rock
  bucket.updateMatrixWorld(true);
  rocks.dump(anywhere);
  fallFor(rocks, 1);
  const big = rocks.rocks[0];
  assert.ok(small.y > big.y + big.h / 2, `stacked: ${small.y} over ${big.y + big.h / 2}`);

  rocks.scoop({ x: 0, z: 0 });
  rocks.dump({ contains: () => ({ x: 50, z: 50 }) }); // the table edge said "here"
  fallFor(rocks, 1);
  const moved = rocks.rocks.find((r) => Math.abs(r.x - 50) < 1e-6 && Math.abs(r.z - 50) < 1e-6);
  assert.ok(moved, 'landed where the edge allowed');
});

test('a rock left resting on nothing falls', () => {
  // A rock leaning on the big one's far side, out of the bucket's reach from the near side.
  const model = new THREE.Group();
  const bucket = new THREE.Group();
  model.add(bucket);
  const big = new THREE.Mesh(new THREE.BoxGeometry(60, 40, 50));
  big.position.set(0, 18, 0);
  const leaning = new THREE.Mesh(new THREE.BoxGeometry(30, 26, 30));
  leaning.position.set(30, 48, 0);
  model.add(big, leaning);
  const rocks = new Rocks({
    model,
    rocks: [{ mesh: big, w: 60, h: 40, d: 50 }, { mesh: leaning, w: 30, h: 26, d: 30 }],
    bucket,
    inside: new THREE.Vector3(),
    shadowMaterial: new THREE.MeshBasicMaterial(),
    shadowGeometry: new THREE.PlaneGeometry(1, 1),
  });
  assert.ok(rocks.scoop({ x: -100, z: 0 }));
  assert.equal(rocks.carried.rock.mesh, big);
  assert.equal(rocks.rocks[1].state, 'falling');
  fallFor(rocks, 1);
  assert.ok(Math.abs(leaning.position.y - (26 / 2 - 2)) < 1e-6, `it fell to the table: ${leaning.position.y}`);
  assert.equal(leaning.position.x, 30, 'straight down');
});

test('state() and restore() round-trip, including a rock in the bucket; reset() rebuilds the pile', () => {
  const { rocks, bucket } = pile();
  rocks.scoop({ x: 200, z: 0 });
  rocks.carry(1);
  const saved = rocks.state();
  assert.equal(saved.filter((s) => s.carried).length, 1);
  const json = JSON.parse(JSON.stringify(saved));

  const other = pile();
  assert.ok(other.rocks.restore(json));
  assert.equal(other.rocks.rocks[1].mesh.parent, other.bucket);
  assert.deepEqual(other.rocks.state(), saved);

  assert.equal(other.rocks.restore([{ x: 1 }]), false, 'a record that doesn\'t fit is refused');
  assert.equal(other.rocks.restore(json.map(() => ({ carried: true }))), false, 'two rocks in the bucket is nonsense');

  rocks.reset();
  assert.deepEqual(rocks.state(), rocks.initial);
  assert.equal(rocks.rocks[1].mesh.parent === bucket, false);
});

test('while it is drawn in, a scooped rock never dips into the table', () => {
  const { rocks, bucket } = pile();
  const rock = rocks.rocks[1];
  rocks.scoop({ x: 200, z: 0 });
  // The bucket's inside right down at table level, and tipped: drawing the rock in would push it under.
  bucket.position.set(265, -30, 0);
  bucket.rotation.z = 0.8;
  for (const f of [0.2, 0.5, 0.8, 0.99]) {
    rocks.carry(f);
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(new THREE.Vector3((sx * rock.w) / 2, (sy * rock.h) / 2, (sz * rock.d) / 2).applyQuaternion(rock.mesh.quaternion).y + rock.mesh.position.y);
    }
    assert.ok(Math.min(...corners) >= -2 - 1e-9, `at ${f} its lowest corner is at ${Math.min(...corners)}`);
  }
});
