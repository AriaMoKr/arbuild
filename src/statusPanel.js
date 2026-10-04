import * as THREE from 'three';

// Quest Browser has no DOM overlay in immersive-ar, so in-headset messages are drawn
// to a canvas and shown on a small panel that lazily follows the user's head.
//
// Every text change re-uploads the canvas to the GPU, and on the Quest that cost a
// 23 ms frame while the room's tables were arriving (the text changed several times).
// So the canvas has one fixed size, and its texture is updated in place rather than
// reallocated; 768 px wide is still as sharp as the headset shows it at this size; and
// there are no mipmaps to rebuild, since the panel is always seen up close.

const PANEL_WIDTH_M = 0.56;
const CANVAS_WIDTH = 768;
const PADDING = 33;
const TITLE_FONT = '600 39px system-ui, -apple-system, "Segoe UI", sans-serif';
const BODY_FONT = '400 29px system-ui, -apple-system, "Segoe UI", sans-serif';
const TITLE_LINE = 50;
const BODY_LINE = 38;
const MAX_LINES = 5; // body lines; the longest message ('placed' with several tables) has 4
const CANVAS_HEIGHT = PADDING * 2 + TITLE_LINE + MAX_LINES * BODY_LINE;
const FOLLOW_OFFSET = new THREE.Vector3(0, -0.12, -0.85); // in front of and slightly below the eyes

export class StatusPanel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;

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
    this.mesh.scale.set(PANEL_WIDTH_M, (PANEL_WIDTH_M * CANVAS_HEIGHT) / CANVAS_WIDTH, 1);

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
    const shown = lines.slice(0, MAX_LINES);
    // The box fits the text and sits in the middle of the fixed-size canvas; the rest stays transparent.
    const height = PADDING * 2 + TITLE_LINE + shown.length * BODY_LINE;
    const top = Math.round((CANVAS_HEIGHT - height) / 2);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(16, 18, 24, 0.82)';
    ctx.beginPath();
    ctx.roundRect(0, top, canvas.width, height, 27);
    ctx.fill();

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = TITLE_FONT;
    ctx.fillText(title, PADDING, top + PADDING, canvas.width - PADDING * 2);
    ctx.fillStyle = '#c9d1e0';
    ctx.font = BODY_FONT;
    shown.forEach((line, i) => {
      ctx.fillText(line, PADDING, top + PADDING + TITLE_LINE + i * BODY_LINE, canvas.width - PADDING * 2);
    });
    this.texture.needsUpdate = true; // same size every time, so three updates it in place
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
