import * as THREE from 'three';

// A small in-AR menu above the left controller (or the left hand): Exit AR, Reload page,
// Sound on/off, Steering relative/absolute, and when the app last changed. Point at it with
// the other hand's controller (or pinch ray); a ray shows where you're pointing, and the
// trigger or a pinch presses the button. The browser's own controls are out of reach in AR,
// which is why this exists.

const CANVAS_W = 640;
const CANVAS_H = 350;
export const MENU_CANVAS = { width: CANVAS_W, height: CANVAS_H };
const MENU_WIDTH_M = 0.18;
const MENU_HEIGHT_M = (MENU_WIDTH_M * CANVAS_H) / CANVAS_W;
const LIFT_M = 0.1; // how far above the holding hand the menu floats
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const VERSION_Y = 305; // the "Updated …" line, under the buttons

/** Button rectangles in canvas pixels (y down). Labels of sound and steering are set by setLabel(). */
export const MENU_BUTTONS = [
  { id: 'exit', label: 'Exit AR', x: 24, y: 24, w: 188, h: 120 },
  { id: 'reload', label: '↻ Reload', x: 226, y: 24, w: 188, h: 120 },
  { id: 'sound', label: 'Sound', x: 428, y: 24, w: 188, h: 120 },
  { id: 'steering', label: 'Steering', x: 24, y: 160, w: 592, h: 100 },
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
  constructor({ onExit, onReload, onSound, onSteering }) {
    this.actions = { exit: onExit, reload: onReload, sound: onSound, steering: onSteering };
    this.labels = {};
    this.version = '';
    this.hovered = null;
    this.holder = null; // 'left controller' | 'left hand' while visible

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false; // re-uploaded on every hover change; always seen up close
    this.texture.minFilter = THREE.LinearFilter;

    this.group = new THREE.Group();
    this.group.visible = false;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(MENU_WIDTH_M, MENU_HEIGHT_M),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.group.add(this.panel);

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
    this.draw();
  }

  /** Changes a button's label, e.g. setLabel('sound', 'Sound off'). */
  setLabel(id, label) {
    if (this.labels[id] === label) return;
    this.labels[id] = label;
    this.draw();
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
    this.hovered = id;
    this.draw();
  }

  draw() {
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);
    g.fillStyle = 'rgba(16, 18, 24, 0.85)';
    g.beginPath();
    g.roundRect(0, 0, CANVAS_W, CANVAS_H, 28);
    g.fill();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const b of MENU_BUTTONS) {
      g.fillStyle = b.id === this.hovered ? '#5a8fff' : '#2c3342';
      g.beginPath();
      g.roundRect(b.x, b.y, b.w, b.h, 20);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = `600 38px ${FONT}`;
      g.fillText(this.labels[b.id] ?? b.label, b.x + b.w / 2, b.y + b.h / 2, b.w - 20);
    }

    g.fillStyle = '#c9d1e0';
    g.font = `400 30px ${FONT}`;
    g.fillText(this.version || 'Updated: unknown', CANVAS_W / 2, VERSION_Y, CANVAS_W - 48);
    this.texture.needsUpdate = true;
  }
}
