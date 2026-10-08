import * as THREE from 'three';

// A small in-AR menu above the left controller (or the left hand): Exit AR, Reload page,
// Sound on/off, Steering relative/absolute, Reset (the dig site as it started), Look
// (diorama/plain), and when the app last changed. Point at it with
// the other hand's controller (or pinch ray); a ray shows where you're pointing, and the
// trigger or a pinch presses the button. The browser's own controls are out of reach in AR,
// which is why this exists.

const CANVAS_W = 640;
const CANVAS_H = 466;
export const MENU_CANVAS = { width: CANVAS_W, height: CANVAS_H };
const MENU_WIDTH_M = 0.18;
const MENU_HEIGHT_M = (MENU_WIDTH_M * CANVAS_H) / CANVAS_W;
const LIFT_M = 0.1; // how far above the holding hand the menu floats
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const VERSION_Y = 421; // the "Updated …" line, under the buttons

/** Button rectangles in canvas pixels (y down). Labels of sound and steering are set by setLabel(). */
export const MENU_BUTTONS = [
  { id: 'exit', label: 'Exit AR', x: 24, y: 24, w: 188, h: 120 },
  { id: 'reload', label: '↻ Reload', x: 226, y: 24, w: 188, h: 120 },
  { id: 'sound', label: 'Sound', x: 428, y: 24, w: 188, h: 120 },
  { id: 'steering', label: 'Steering', x: 24, y: 160, w: 390, h: 100 },
  { id: 'reset', label: '↺ Reset', x: 428, y: 160, w: 188, h: 100 },
  { id: 'look', label: 'Look', x: 24, y: 276, w: 592, h: 100 },
];

/**
 * The button under texture coordinates (u, v) as three.js reports them (v = 0 at the
 * bottom of the panel), or null.
 */
export function buttonAt(u, v, buttons = MENU_BUTTONS) {
  const x = u * CANVAS_W;
  const y = (1 - v) * CANVAS_H;
  return buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)?.id ?? null;
}

export class XrMenu {
  constructor({ onExit, onReload, onSound, onSteering, onReset, onLook }) {
    this.actions = { exit: onExit, reload: onReload, sound: onSound, steering: onSteering, reset: onReset, look: onLook };
    this.labels = {};
    this.version = '';
    this.hovered = null;
    this.holder = null; // 'left controller' | 'left hand' while visible

    // The panel (background and version line) and each button have their own canvas, so a
    // hover or label change re-uploads only that button's small texture.
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.texture = canvasTexture(this.canvas);

    this.group = new THREE.Group();
    this.group.visible = false;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(MENU_WIDTH_M, MENU_HEIGHT_M),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.group.add(this.panel);
    this.buttons = new Map();
    const metresPerPixel = MENU_WIDTH_M / CANVAS_W;
    for (const b of MENU_BUTTONS) {
      const canvas = document.createElement('canvas');
      canvas.width = b.w;
      canvas.height = b.h;
      const texture = canvasTexture(canvas);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(b.w * metresPerPixel, b.h * metresPerPixel),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
      );
      // On the panel at the button's place, a hair in front, drawn after it. Raycasts hit the panel.
      mesh.position.set((b.x + b.w / 2 - CANVAS_W / 2) * metresPerPixel, (CANVAS_H / 2 - b.y - b.h / 2) * metresPerPixel, 0.0005);
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.buttons.set(b.id, { button: b, canvas, texture });
    }

    // The pointing ray: a thin cylinder from the pointer to where it meets the menu.
    this.ray = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0015, 0.0015, 1, 6).translate(0, 0.5, 0), // base at the origin, along +Y
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, toneMapped: false }),
    );
    this.ray.visible = false;
    this.cursor = new THREE.Mesh(
      new THREE.SphereGeometry(0.004, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    this.cursor.visible = false;
    this.root = new THREE.Group();
    this.root.add(this.group, this.ray, this.cursor);

    this._raycaster = new THREE.Raycaster();
    this._m = new THREE.Matrix4();
    this._origin = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this.draw();
  }

  setVersion(text) {
    this.version = text;
    this._drawPanel();
  }

  /** Changes a button's label, e.g. setLabel('sound', 'Sound off'). */
  setLabel(id, label) {
    if (this.labels[id] === label) return;
    this.labels[id] = label;
    this._drawButton(id);
  }

  /** Called once per XR frame: places the menu on the holding hand and tracks the pointer. */
  update(frame, refSpace, viewer) {
    const holder = this._holderPose(frame, refSpace);
    this.holder = holder?.label ?? null;
    if (!holder || !viewer) {
      this.group.visible = false;
      this._setHover(null);
      this.ray.visible = this.cursor.visible = false;
      return;
    }
    const p = holder.pose.transform.position;
    this.group.position.set(p.x, p.y + LIFT_M, p.z);
    this.group.lookAt(viewer.x, viewer.y, viewer.z); // +Z (the panel's front) faces the user
    this.group.visible = true;
    this.group.updateMatrixWorld(true);

    const pointer = this._pointerSource(frame, holder.handedness);
    const hit = pointer && this._hit(frame, pointer, refSpace);
    this._setHover(hit ? buttonAt(hit.uv.x, hit.uv.y) : null);
    if (hit) {
      this._showRay(this._origin, hit.point);
    } else {
      this.ray.visible = this.cursor.visible = false;
    }
  }

  /** The button `inputSource`'s ray points at in `frame`, or null (used for select events). */
  buttonFor(frame, inputSource, refSpace) {
    if (!this.group.visible || inputSource.handedness === this._holderHandedness) return null;
    const hit = this._hit(frame, inputSource, refSpace);
    return hit ? buttonAt(hit.uv.x, hit.uv.y) : null;
  }

  press(id) {
    console.info(`[menu] ${id} pressed`); // shows up in the debug log, even before a reload
    this.actions[id]?.();
  }

  hide() {
    this.group.visible = this.ray.visible = this.cursor.visible = false;
    this.holder = null;
    this._setHover(null);
  }

  /** World-space centres of the buttons, plus visibility and hover, for tests and the debug log. */
  snapshot() {
    const buttons = {};
    if (this.group.visible) {
      for (const b of MENU_BUTTONS) {
        const local = new THREE.Vector3(
          ((b.x + b.w / 2) / CANVAS_W - 0.5) * MENU_WIDTH_M,
          (0.5 - (b.y + b.h / 2) / CANVAS_H) * MENU_HEIGHT_M,
          0,
        );
        buttons[b.id] = this.panel.localToWorld(local).toArray().map((v) => Math.round(v * 1000) / 1000);
      }
    }
    return { visible: this.group.visible, holder: this.holder, hovered: this.hovered, buttons, labels: { ...this.labels } };
  }

  // ---------- internals ----------

  _holderPose(frame, refSpace) {
    for (const source of frame.session.inputSources) {
      if (source.handedness !== 'left') continue;
      let pose = source.gripSpace ? frame.getPose(source.gripSpace, refSpace) : null;
      if (!pose && source.hand && frame.getJointPose) {
        const wrist = source.hand.get('wrist');
        pose = wrist ? frame.getJointPose(wrist, refSpace) : null;
      }
      if (pose) {
        this._holderHandedness = 'left';
        return { pose, handedness: 'left', label: source.hand ? 'left hand' : 'left controller' };
      }
    }
    this._holderHandedness = null;
    return null;
  }

  _pointerSource(frame, holderHandedness) {
    for (const source of frame.session.inputSources) {
      if (source.handedness !== holderHandedness && source.targetRayMode === 'tracked-pointer') return source;
    }
    return null;
  }

  /** Raycast from the source's target ray into the menu panel; { point, uv } or null. */
  _hit(frame, source, refSpace) {
    const pose = frame.getPose(source.targetRaySpace, refSpace);
    if (!pose) return null;
    this._m.fromArray(pose.transform.matrix);
    this._origin.setFromMatrixPosition(this._m);
    this._direction.set(0, 0, -1).transformDirection(this._m);
    this._raycaster.set(this._origin, this._direction);
    const [hit] = this._raycaster.intersectObject(this.panel, false);
    return hit && hit.uv ? { point: hit.point, uv: hit.uv } : null;
  }

  _showRay(from, to) {
    const length = from.distanceTo(to);
    this.ray.position.copy(from);
    this.ray.quaternion.setFromUnitVectors(this._up, this._direction);
    this.ray.scale.set(1, length, 1);
    this.ray.visible = true;
    this.cursor.position.copy(to);
    this.cursor.visible = true;
  }

  _setHover(id) {
    if (id === this.hovered) return;
    const before = this.hovered;
    this.hovered = id;
    if (before) this._drawButton(before);
    if (id) this._drawButton(id);
  }

  /** Draws everything: the panel and every button. */
  draw() {
    this._drawPanel();
    for (const id of this.buttons.keys()) this._drawButton(id);
  }

  _drawPanel() {
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);
    g.fillStyle = 'rgba(16, 18, 24, 0.85)';
    g.beginPath();
    g.roundRect(0, 0, CANVAS_W, CANVAS_H, 28);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#c9d1e0';
    g.font = `400 30px ${FONT}`;
    g.fillText(this.version || 'Updated: unknown', CANVAS_W / 2, VERSION_Y, CANVAS_W - 48);
    this.texture.needsUpdate = true;
  }

  _drawButton(id) {
    const { button: b, canvas, texture } = this.buttons.get(id);
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, b.w, b.h);
    g.fillStyle = id === this.hovered ? '#5a8fff' : '#2c3342';
    g.beginPath();
    g.roundRect(0, 0, b.w, b.h, 20);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `600 38px ${FONT}`;
    g.fillText(this.labels[id] ?? b.label, b.w / 2, b.h / 2, b.w - 20);
    texture.needsUpdate = true;
  }
}

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false; // re-uploaded on changes; always seen up close
  texture.minFilter = THREE.LinearFilter;
  return texture;
}
