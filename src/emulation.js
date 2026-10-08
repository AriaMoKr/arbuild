// Desktop-only Quest 3 emulation with Meta's Immersive Web Emulation Runtime (IWER)
// and its Synthetic Environment Module (SEM), which supplies a scanned room with
// labelled planes and meshes, tables included. Loaded only from the dev server.
import * as THREE from 'three';
import { XRDevice, XRWebGLDepthInformation, metaQuest3 } from 'iwer';
import { SyntheticEnvironmentModule } from '@iwer/sem';

// IWER's GPU depth map holds 1 - near/z, the depth buffer of a projection with an infinite
// far plane, but its depthFar reports the session's far plane. src/occlusion.js reads this
// instead.
Object.defineProperty(XRWebGLDepthInformation.prototype, 'encodedDepthFar', { value: Infinity });

export const ENVIRONMENTS = ['meeting_room', 'office_small', 'living_room', 'office_large', 'music_room'];

export async function installEmulation({ env = 'meeting_room', showPlanes = false } = {}) {
  if (!ENVIRONMENTS.includes(env)) throw new Error(`Unknown environment "${env}". Use one of: ${ENVIRONMENTS.join(', ')}`);

  const xrDevice = new XRDevice(metaQuest3, { stereoEnabled: false }); // mono: one full-window view
  // Desktop Chrome already has a navigator.xr (without AR support); force IWER over it.
  xrDevice.installRuntime({ forceInstall: true });
  xrDevice.installSEM(SyntheticEnvironmentModule); // takes the class, not an instance
  await xrDevice.sem.loadDefaultEnvironment(env);
  if (showPlanes) {
    xrDevice.sem.planesVisible = true;
    xrDevice.sem.boundingBoxesVisible = true;
  }

  // Test hooks for scripts/e2e.mjs. addProp puts a box into the synthetic room (it shows in
  // the depth map, like a real thing on the table); `at` is its centre in room metres.
  const addProp = ({ at, size }) => {
    const prop = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color: 0x9a9a9a }));
    prop.position.set(...at);
    xrDevice.sem.meshes.add(prop); // SEM renders this group into the depth map
    return () => xrDevice.sem.meshes.remove(prop);
  };
  window.__iwer = { xrDevice, env, addProp };
  console.info(`[emulation] IWER Quest 3 with synthetic room "${env}"`);
  return xrDevice;
}
