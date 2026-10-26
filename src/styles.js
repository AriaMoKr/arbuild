import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Looks for the dig site. src/digSite.js builds every part through one of these: which
// material a colour gets, which geometry a box, cylinder, sphere or rock gets, what the
// contact shadows look like, extras added once the site is built (outlines, edges, dirt)
// and whether it leaves marks on the table (src/groundMarks.js). 'diorama' (the default)
// and 'plain' are the app's looks, switched on the menu; the others are sketches of art
// directions, only picked with ?style= on the dev server.
//
// Parts come with a role, so a look can treat them differently: 'paint' (the excavator's
// body, which B repaints), 'tyre', 'metal' (hubs, bucket, teeth), 'dark' (undercarriage,
// mounts), 'skin', 'hat', 'eye', 'cloth' (everything else on the people) and 'rock'.

export const STYLES = ['diorama', 'plain', 'toy', 'wood', 'cartoon', 'hologram', 'clay'];

const plainBox = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const plainCylinder = (r, h, segments) => new THREE.CylinderGeometry(r, r, h, segments);
const plainSphere = (r) => new THREE.SphereGeometry(r, 16, 12);

/** The look called `name` (unknown names get 'plain'). */
export function makeLook(name) {
  const make = LOOKS[name] ?? LOOKS.plain;
  return { box: plainBox, cylinder: plainCylinder, sphere: plainSphere, rock: plainBox, shadow: () => {}, decorate: () => {}, marks: false, ...make() };
}

const LOOKS = {
  // The first look: smooth, clean colours.
  plain: () => ({
    material: (colour, role) => new THREE.MeshStandardMaterial({ color: colour, roughness: role === 'paint' ? 0.55 : 0.75 }),
  }),

  // A new plastic toy: glossy, saturated, rounded edges, bright metal hubs.
  toy: () => ({
    material: (colour, role) => {
      if (role === 'tyre') return new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.65 });
      if (role === 'metal') return new THREE.MeshStandardMaterial({ color: 0xe4e8ee, metalness: 0.45, roughness: 0.22 });
      const color = role === 'paint' ? new THREE.Color(0xffc000) : tweak(colour, { saturation: 1.35, lightness: 1.05 });
      return new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
    },
    box: (w, h, d) => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.2),
    rock: (w, h, d) => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.3),
  }),

  // Hand-painted wooden toy: matte, grain showing through the paint, rounded blocks.
  wood: () => {
    const grain = grainTexture();
    const tint = { paint: 0xf4c542, tyre: 0x5a3f2c, metal: 0xc9a77e, dark: 0x8a6544, skin: 0xffffff, hat: 0xffffff, eye: 0x3a2a1e };
    return {
      material: (colour, role) =>
        new THREE.MeshStandardMaterial({ map: grain, color: tint[role] ?? (role === 'rock' ? woodTint(colour) : tweak(colour, { saturation: 0.8, lightness: 1.15 })), roughness: 0.85 }),
      box: (w, h, d) => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.15),
      rock: (w, h, d) => new RoundedBoxGeometry(w * 0.9, h, d * 0.9, 3, Math.min(w, h, d) * 0.25),
    };
  },

  // A tabletop wargaming diorama: earthy colours, flat-shaded facets, faceted rocks, on its
  // own patch of ground with a dirt mound under the pile, clods and grass round the rim.
  // The excavator leaves tracks, digs and spills on the table (src/groundMarks.js).
  // Nothing goes below the table: the ground is a hair under the site's base (the contact
  // shadows sit at y = 1, the marks between) and everything on it has a flat bottom.
  diorama: () => ({
    material: (colour, role) =>
      new THREE.MeshStandardMaterial({ color: role === 'paint' ? 0xc8902a : tweak(colour, { saturation: 0.7, lightness: 0.92 }), roughness: 0.95, flatShading: true }),
    cylinder: (r, h, segments) => new THREE.CylinderGeometry(r, r, h, Math.max(6, Math.round(segments * 0.6))),
    sphere: (r) => new THREE.IcosahedronGeometry(r, 1),
    rock: (w, h, d, i) => jittered(new THREE.IcosahedronGeometry(0.5, 0), w, h * 1.1, d, i),
    marks: true,
    decorate: ({ model, centre, radius, pile, clear }) => {
      const random = seeded(3);
      // The dirt is mottled by vertex colours, so every geometry it's on gets them (shade()).
      const dirt = new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 1, flatShading: true, vertexColors: true });
      const ground = new THREE.CircleGeometry(radius * 0.97, 28);
      const p = ground.attributes.position;
      for (let i = 1; i < p.count; i++) {
        const k = 0.9 + random() * 0.12; // a ragged rim
        p.setXY(i, p.getX(i) * k, p.getY(i) * k);
      }
      shade(ground, 4, 0.2);
      const place = (mesh, x, z) => {
        mesh.position.set(x, -0.5, z);
        mesh.userData.ground = true; // lies on the table: not a part the e2e checks
        model.add(mesh);
        return mesh;
      };
      place(new THREE.Mesh(ground.rotateX(-Math.PI / 2), dirt), centre.x, centre.z);
      place(new THREE.Mesh(moundGeometry(260, 30, 220, 7), dirt), pile.x, pile.z);
      // Clods here and there, clear of where the excavator, the worker and the rocks stand.
      for (let placed = 0, tries = 0; placed < 7 && tries < 60; tries++) {
        const a = random() * Math.PI * 2;
        const r = radius * (0.35 + random() * 0.5);
        const [x, z] = [centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r];
        if (clear.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 15)) continue;
        place(new THREE.Mesh(moundGeometry(20, 11, 17, 20 + placed), dirt), x, z).rotation.y = random() * 3;
        placed++;
      }
      // Pebbles, and a plank someone left by the rim.
      const stone = new THREE.MeshStandardMaterial({ color: 0x9a8f80, roughness: 1, flatShading: true });
      for (let placed = 0, tries = 0; placed < 10 && tries < 80; tries++) {
        const a = random() * Math.PI * 2;
        const r = radius * (0.2 + random() * 0.7);
        const [x, z] = [centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r];
        if (clear.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 10)) continue;
        const size = 6 + random() * 6;
        const pebble = new THREE.Mesh(jittered(new THREE.IcosahedronGeometry(0.5, 0), size * 1.3, size, size, 40 + placed), stone);
        place(pebble, x, z).position.y += size * 0.45; // jittered keeps the bottom at -0.45 of its height
        pebble.rotation.y = random() * 3;
        placed++;
      }
      const wood = new THREE.MeshStandardMaterial({ color: 0xa88358, roughness: 0.9, flatShading: true });
      for (let tries = 0; tries < 40; tries++) {
        const a = random() * Math.PI * 2;
        const r = radius * 0.72;
        const [x, z] = [centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r];
        if (clear.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 70)) continue;
        const plank = place(new THREE.Mesh(new THREE.BoxGeometry(120, 5, 28).translate(0, 2.5, 0), wood), x, z);
        plank.rotation.y = a + Math.PI / 2 + (random() - 0.5) * 0.6; // lying along the rim, roughly
        break;
      }
      const grass = new THREE.MeshStandardMaterial({ color: 0x6f8f3a, roughness: 1, flatShading: true });
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + random() * 0.2;
        const r = radius * (0.86 + random() * 0.1);
        const height = 18 + random() * 14;
        const base = 7 + random() * 5;
        const tuft = new THREE.Mesh(new THREE.ConeGeometry(base, height, 5).translate(0, height / 2, 0), grass);
        place(tuft, centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r);
        tuft.rotation.set((random() - 0.5) * 0.3, random() * 3, (random() - 0.5) * 0.3);
        tuft.position.y += base * (Math.abs(Math.sin(tuft.rotation.x)) + Math.abs(Math.sin(tuft.rotation.z))); // leaning, its base edge stays up
      }
    },
  }),

  // A cartoon: three-tone shading and black outlines (each part's back faces, scaled out).
  cartoon: () => {
    const gradientMap = toonGradient();
    return {
      material: (colour, role) =>
        new THREE.MeshToonMaterial({ color: role === 'paint' ? 0xffc21a : tweak(colour, { saturation: 1.3, lightness: 1.1 }), gradientMap }),
      decorate: ({ model }) => outline(model, 3.2),
    };
  },

  // A projected engineering model: see-through cyan, bright edges, a grid on the table.
  hologram: () => {
    const body = (opacity) => new THREE.MeshBasicMaterial({ color: 0x38d9ff, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    return {
      material: (colour, role) => body(role === 'paint' ? 0.22 : 0.12),
      shadow: (material) => {
        material.visible = false; // nothing solid to cast one
      },
      decorate: ({ model, centre, radius }) => {
        edges(model, new THREE.LineBasicMaterial({ color: 0x9cf2ff, transparent: true, opacity: 0.9 }));
        model.add(grid(centre, radius, 40, new THREE.LineBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.35 })));
      },
    };
  },

  // Plasticine: soft lumpy shapes, matte, warm saturated colours.
  clay: () => ({
    material: (colour, role) =>
      new THREE.MeshStandardMaterial({ color: role === 'paint' ? 0xf7a21b : tweak(colour, { saturation: 1.25, lightness: 1.12 }), roughness: 1 }),
    box: (w, h, d) => lumpy(new RoundedBoxGeometry(w, h, d, 4, Math.min(w, h, d) * 0.4), 0.07),
    cylinder: (r, h, segments) => lumpy(new THREE.CylinderGeometry(r * 0.94, r, h, Math.max(segments, 18), 4), 0.06),
    sphere: (r) => lumpy(new THREE.SphereGeometry(r, 20, 14), 0.06),
    rock: (w, h, d) => lumpy(new THREE.SphereGeometry(0.5, 18, 12).scale(w, h * 1.1, d), 0.1),
  }),
};

// ---------- helpers ----------

/** A colour with its saturation and lightness scaled (HSL, sRGB). */
function tweak(colour, { saturation = 1, lightness = 1 }) {
  const hsl = new THREE.Color(colour).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * saturation), Math.min(1, hsl.l * lightness), THREE.SRGBColorSpace);
}

/** A rock's grey, as a light or dark natural wood. */
function woodTint(colour) {
  return new THREE.Color(colour).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l > 0.52 ? new THREE.Color(0xf0dcc0) : new THREE.Color(0xc79a6b);
}

/** A repeatable random sequence, so a look is the same every time. */
function seeded(seed) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** A faceted heap w x h x d with a flat bottom at y = 0, mottled (vertex colours). */
export function moundGeometry(w, h, d, seed) {
  const geometry = jittered(new THREE.IcosahedronGeometry(0.5, 1), w, h * 2, d, seed);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, Math.max(0, p.getY(i)));
  geometry.computeVertexNormals();
  return shade(geometry, seed, 0.25);
}

/** Gives `geometry` vertex colours: white darkened by up to `amount`, at random (the same each time). */
function shade(geometry, seed, amount) {
  const random = seeded(seed + 23);
  const p = geometry.attributes.position;
  const colours = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) colours.fill(1 - random() * amount, i * 3, i * 3 + 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

/** `geometry` (about unit size) scaled to w x h x d, its vertices pushed about a little. */
function jittered(geometry, w, h, d, seed) {
  const random = seeded(seed + 11);
  const p = geometry.attributes.position;
  const moved = new Map(); // vertices at the same place move together, so faces stay closed
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    if (!moved.has(key)) moved.set(key, 0.82 + random() * 0.3);
    const k = moved.get(key);
    p.setXYZ(i, p.getX(i) * w * k, Math.max(p.getY(i) * h * k, -h * 0.45), p.getZ(i) * d * k);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * `geometry` with a soft lumpiness pushed out from its centre, `amount` of its size deep,
 * a couple of lumps across whatever its size (vertices at one place move together).
 */
function lumpy(geometry, amount) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const p = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const [x, y, z] = [v.x / (size.x || 1), v.y / (size.y || 1), v.z / (size.z || 1)];
    const n = Math.sin(x * 7 + y * 3 + 1.3) * Math.sin(y * 6 - z * 4 + 0.4) * Math.sin(z * 7 + x * 2 + 2.1);
    v.x += x * size.x * n * amount * 2;
    v.y += y * size.y * n * amount * 2;
    v.z += z * size.z * n * amount * 2;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Wood grain on a canvas: wavy darker stripes on a pale beech. */
function grainTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#e9cfa6';
  g.fillRect(0, 0, size, size);
  const random = seeded(5);
  for (let i = 0; i < 46; i++) {
    const y0 = random() * size;
    g.strokeStyle = `rgba(${120 + random() * 40}, ${80 + random() * 30}, ${40 + random() * 20}, ${0.12 + random() * 0.22})`;
    g.lineWidth = 0.8 + random() * 2.2;
    g.beginPath();
    for (let x = 0; x <= size; x += 8) g.lineTo(x, y0 + Math.sin(x * 0.03 + i) * 5 + Math.sin(x * 0.11 + i * 2) * 1.5);
    g.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Three hard steps of light, for MeshToonMaterial. */
function toonGradient() {
  const texture = new THREE.DataTexture(new Uint8Array([90, 175, 255]), 3, 1, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Every solid part gets a black outline: its back faces, `thickness` units bigger all round. */
function outline(root, thickness) {
  const black = new THREE.MeshBasicMaterial({ color: 0x15171a, side: THREE.BackSide });
  const parts = [];
  root.traverse((o) => {
    if (o.isMesh && !o.userData.shadow) parts.push(o);
  });
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  for (const mesh of parts) {
    mesh.geometry.computeBoundingBox();
    box.copy(mesh.geometry.boundingBox).getSize(size);
    box.getCenter(centre);
    const hull = new THREE.Mesh(mesh.geometry, black);
    const s = (n) => 1 + (2 * thickness) / Math.max(n, thickness);
    hull.scale.set(s(size.x), s(size.y), s(size.z));
    hull.position.set(centre.x * (1 - hull.scale.x), centre.y * (1 - hull.scale.y), centre.z * (1 - hull.scale.z));
    mesh.add(hull);
  }
}

/** Every solid part gets its edges drawn. */
function edges(root, material) {
  const parts = [];
  root.traverse((o) => {
    if (o.isMesh && !o.userData.shadow) parts.push(o);
  });
  for (const mesh of parts) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), material));
}

/** A square grid of `step` units, inside a circle round `centre`, just above the table. */
function grid(centre, radius, step, material) {
  const points = [];
  for (let a = -radius; a <= radius; a += step) {
    const half = Math.sqrt(Math.max(0, radius * radius - a * a));
    points.push(centre.x + a, 1, centre.z - half, centre.x + a, 1, centre.z + half);
    points.push(centre.x - half, 1, centre.z + a, centre.x + half, 1, centre.z + a);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(geometry, material);
}
