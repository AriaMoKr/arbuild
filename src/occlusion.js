import * as THREE from 'three';

// Soft depth occlusion for the dig site, in its own materials.
//
// three.js's built-in occlusion writes the headset's depth map straight into the depth
// buffer. On the Quest that looked blocky around hands (one coarse depth texel per
// pixel), and things resting on the real table flickered and lost their shadows (the
// table's measured depth is noisy, so pixels on it flipped between hidden and shown).
// So that pass is switched off, and each dig site material samples the depth map itself:
// - a real surface hides a pixel only if it is more than ~2 cm in front of it, fading in
//   fully by ~5 cm, so anything sitting on the table is never hidden by the table;
// - 9 depth samples around the pixel are averaged, for soft edges. Opaque materials turn
//   the result into MSAA coverage (alphaToCoverage), so they need no transparency sorting.
//
// Both depths are compared in metres. The depth map holds depth-buffer values for a
// projection with the depth information's near/far planes; three's own pass relies on
// that too, writing them straight into the depth buffer. The pixel's own distance comes
// from gl_FragCoord.z and the XR camera's near/far. A far plane of 0 means infinite:
// IWER (the Quest emulator) encodes 1 - near/z whatever far it reports, so
// src/emulation.js marks its depth information with `encodedDepthFar = Infinity`.
// Reading it with the reported far made real surfaces look a few cm nearer, enough to hide
// things resting on the table. The headset's values are logged ('[depth] depth map: ...').

const TOLERANCE_START_M = 0.02; // real surface this much nearer: starts to hide
const TOLERANCE_FULL_M = 0.05; // this much nearer: fully hidden
const SAMPLE_SPREAD_TEXELS = 1.5;

const DECLARATIONS = /* glsl */ `
uniform highp sampler2DArray occlusionDepth;
uniform bool occlusionEnabled;
uniform vec2 occlusionEyeSize;
uniform float occlusionNear; // the XR camera's projection
uniform float occlusionFar; // 0 = infinite
uniform float occlusionDepthNear; // the depth map's projection
uniform float occlusionDepthFar; // 0 = infinite
uniform bool occlusionDebug; // dev only: show the depths as colours instead

float occlusionMetres(float d, float near, float far) { // window depth -> distance
  if (far <= 0.0) return near / max(1.0 - d, 1e-7);
  return near * far / max(far - d * (far - near), 1e-7);
}
float occlusionPixelMetres(float d) {
  return occlusionMetres(d, occlusionNear, occlusionFar);
}
float occlusionRealMetres(float raw) {
  return occlusionMetres(raw, occlusionDepthNear, occlusionDepthFar);
}
float occlusionHidden() {
  vec2 uv = gl_FragCoord.xy / occlusionEyeSize; // the eyes are side by side in the framebuffer
  float layer = 0.0;
  if (uv.x >= 1.0) { uv.x -= 1.0; layer = 1.0; }
  float z = occlusionPixelMetres(gl_FragCoord.z);
  vec2 spread = ${SAMPLE_SPREAD_TEXELS.toFixed(1)} / vec2(textureSize(occlusionDepth, 0).xy);
  float hidden = 0.0;
  float samples = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      float raw = texture(occlusionDepth, vec3(uv + vec2(float(x), float(y)) * spread, layer)).r;
      if (raw <= 0.0) continue; // no depth measured here
      float real = occlusionRealMetres(raw);
      // Fully hidden when the real surface is TOLERANCE_FULL nearer, not at all within TOLERANCE_START.
      hidden += 1.0 - smoothstep(z - ${TOLERANCE_FULL_M.toFixed(3)}, z - ${TOLERANCE_START_M.toFixed(3)}, real);
      samples += 1.0;
    }
  }
  return samples > 0.0 ? hidden / samples : 0.0;
}
// Debug view (?occlusion=debug in dev): red = how hidden, green = real distance / 3 m,
// blue = this pixel's distance / 3 m, at the pixel's own spot in the depth map.
vec3 occlusionDebugColour() {
  vec2 uv = gl_FragCoord.xy / occlusionEyeSize;
  float layer = 0.0;
  if (uv.x >= 1.0) { uv.x -= 1.0; layer = 1.0; }
  float raw = texture(occlusionDepth, vec3(uv, layer)).r;
  return vec3(occlusionHidden(), raw > 0.0 ? occlusionRealMetres(raw) / 3.0 : 0.0, occlusionPixelMetres(gl_FragCoord.z) / 3.0);
}
`;

const APPLY = /* glsl */ `
  if (occlusionEnabled && occlusionDebug) {
    gl_FragColor = vec4(occlusionDebugColour(), 1.0);
  } else if (occlusionEnabled) {
    gl_FragColor.a *= 1.0 - occlusionHidden();
    if (gl_FragColor.a < 0.02) discard;
  }
`;

export class SoftOcclusion {
  constructor(renderer) {
    this.renderer = renderer;
    this.uniforms = {
      occlusionDepth: { value: null },
      occlusionEnabled: { value: false },
      occlusionEyeSize: { value: new THREE.Vector2(1, 1) },
      occlusionNear: { value: 0.01 },
      occlusionFar: { value: 20 },
      occlusionDepthNear: { value: 0.01 },
      occlusionDepthFar: { value: 20 },
      occlusionDebug: { value: false },
    };
    this.info = null; // the depth map's description; logged whenever it changes
    this.enabled = true; // false: never hide anything (a test hook)
    // Stop three drawing its own (hard) occlusion pass; the depth texture still updates.
    renderer.xr.getDepthSensingMesh = () => null;
  }

  /** Makes `material` occludable. Each material only once; call before precompiling. */
  apply(material) {
    if (material.userData.softOcclusion) return;
    material.userData.softOcclusion = true;
    if (!material.transparent) material.alphaToCoverage = true; // soft edges on opaque parts via MSAA
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
        .replace('#include <dithering_fragment>', `${APPLY}\n#include <dithering_fragment>`);
    };
    material.customProgramCacheKey = () => 'soft-occlusion';
    material.needsUpdate = true;
  }

  /**
   * Once per XR frame, inside the frame callback and before rendering: hand the shaders
   * this frame's depth map and camera. `view` is one of the viewer pose's XRViews.
   */
  update(view) {
    const depth = this.renderer.xr.getDepthTexture();
    const camera = this.renderer.xr.getCamera();
    const eye = camera.cameras[0]?.viewport;
    if (depth && view) this._readInfo(view); // every frame: its near plane follows the session's
    const u = this.uniforms;
    u.occlusionEnabled.value = this.enabled && Boolean(depth) && Boolean(eye) && Boolean(this.info);
    u.occlusionDepth.value = depth;
    if (eye) u.occlusionEyeSize.value.set(eye.z, eye.w);
    u.occlusionNear.value = camera.near;
    u.occlusionFar.value = Number.isFinite(camera.far) ? camera.far : 0;
    if (this.info) {
      u.occlusionDepthNear.value = this.info.near;
      u.occlusionDepthFar.value = Number.isFinite(this.info.far) ? this.info.far : 0;
    }
  }

  /** A new session: forget the old depth map's description. */
  reset() {
    this.info = null;
  }

  _readInfo(view) {
    try {
      const info = this.renderer.xr.getBinding()?.getDepthInformation(view);
      if (!info) return;
      // Without near/far in the depth information, it's in the session's own projection.
      const camera = this.renderer.xr.getCamera();
      const before = this.info;
      this.info = {
        width: info.width,
        height: info.height,
        near: info.depthNear ?? camera.near,
        far: info.encodedDepthFar ?? info.depthFar ?? camera.far,
        reportedFar: info.depthFar ?? null,
        rawValueToMeters: info.rawValueToMeters,
        textureType: info.textureType ?? null,
      };
      if (before && before.near === this.info.near && before.far === this.info.far && before.width === this.info.width) return;
      const metres = (v) => (v === null ? 'none' : Number.isFinite(v) ? `${v} m` : 'infinite');
      const far = this.info.far === this.info.reportedFar ? metres(this.info.far) : `${metres(this.info.reportedFar)} (read as ${metres(this.info.far)})`;
      console.info(
        `[depth] depth map: ${this.info.width}x${this.info.height} ${this.info.textureType ?? ''}, near ${metres(info.depthNear ?? null)}, far ${far}, raw x ${this.info.rawValueToMeters} = metres`,
      );
    } catch (err) {
      console.warn(`[depth] couldn't read the depth information: ${err.message}`);
    }
  }

  /** Dev only: draw the depths as colours (see the shader) instead of hiding anything. */
  set debug(on) {
    this.uniforms.occlusionDebug.value = Boolean(on);
  }

  get active() {
    return this.uniforms.occlusionEnabled.value;
  }
}
