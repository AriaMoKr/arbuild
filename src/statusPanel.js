import * as THREE from 'three';

// Quest Browser has no DOM overlay in immersive-ar, so in-headset messages are drawn
// to a canvas and shown on a small panel that lazily follows the user's head.

const PANEL_WIDTH_M = 0.56;
const CANVAS_WIDTH = 1024;
const PADDING = 44;
const TITLE_FONT = '600 52px system-ui, -apple-system, "Segoe UI", sans-serif';
const BODY_FONT = '400 38px system-ui, -apple-system, "Segoe UI", sans-serif';
const TITLE_LINE = 66;
const BODY_LINE = 50;
const FOLLOW_OFFSET = new THREE.Vector3(0, -0.12, -0.85); // in front of and slightly below the eyes

export class StatusPanel {
  constructor(renderer) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = 320;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;

    this.key = null;
    this.placed = false;
    this._head = new THREE.Vector3();
    this._headRotation = new THREE.Quaternion();
    this._target = new THREE.Vector3();
  }

  /** Show { title, lines[] }, or hide with null. Redraws only when the text changes. */
  show(message) {
    const key = message ? `${message.title}\n${message.lines.join('\n')}` : null;
    if (key === this.key) return;
    this.key = key;
    if (!message) {
      this.mesh.visible = false;
      this.placed = false;
      return;
    }
    this.draw(message);
    this.mesh.visible = true;
  }

  draw({ title, lines }) {
    const { canvas, ctx } = this;
    const height = PADDING * 2 + TITLE_LINE + lines.length * BODY_LINE;
    if (canvas.height !== height) canvas.height = height; // resizing also clears
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(16, 18, 24, 0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 36);
    ctx.fill();

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = TITLE_FONT;
    ctx.fillText(title, PADDING, PADDING, canvas.width - PADDING * 2);
    ctx.fillStyle = '#c9d1e0';
    ctx.font = BODY_FONT;
    lines.forEach((line, i) => {
      ctx.fillText(line, PADDING, PADDING + TITLE_LINE + i * BODY_LINE, canvas.width - PADDING * 2);
    });

    // The canvas height can change, so the texture is recreated rather than updated.
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh.material.map = this.texture;
    this.mesh.scale.set(PANEL_WIDTH_M, (PANEL_WIDTH_M * canvas.height) / canvas.width, 1);
  }

  /** Ease the panel toward a spot in front of the viewer. `viewerPose` is an XRViewerPose. */
  follow(viewerPose, dt) {
    if (!this.mesh.visible || !viewerPose) return;
    const { position, orientation } = viewerPose.transform;
    this._head.set(position.x, position.y, position.z);
    this._headRotation.set(orientation.x, orientation.y, orientation.z, orientation.w);
    this._target.copy(FOLLOW_OFFSET).applyQuaternion(this._headRotation).add(this._head);

    if (!this.placed) {
      this.mesh.position.copy(this._target);
      this.placed = true;
    } else {
      this.mesh.position.lerp(this._target, 1 - Math.exp(-3 * dt));
    }
    this.mesh.lookAt(this._head);
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
