import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { StatusPanel } from './statusPanel.js';
import { nextHue, readRightController, spinVelocity } from './controllerInput.js';
import {
  TableTracker,
  bearingTo,
  isTableLabel,
  tableTopFromMesh,
  tableTopFromPlane,
  viewAngleTo,
} from './tableLocator.js';

const CUBE_EDGE = 0.1; // metres
const MAX_EDGE_FRACTION = 1 / 3; // never wider than a third of the table's shorter side
const SURFACE_GAP = 0.001; // avoid z-fighting with the real table surface
const SCAN_GRACE_MS = 3000; // Meta: scene data can take 2-3 s to arrive after the session starts
const PLACED_HINT_MS = 4000; // how long the 'placed' hint stays up once the cube has been seen
const SEEN_ANGLE = (40 * Math.PI) / 180; // cube within this angle of the gaze counts as seen

// Scene features stay optional: if the user denies spatial data, the session still starts
// and we can explain what's wrong instead of failing to enter AR at all.
const SESSION_INIT = {
  requiredFeatures: [],
  optionalFeatures: ['local-floor', 'plane-detection', 'mesh-detection', 'hand-tracking'],
};

// After leaving AR, the 2D page is where the user fixes these, so repeat the fix there.
const EXIT_HINTS = {
  'no-permission': [
    'Spatial data is blocked. Tap the icon left of the address bar (a lock, or “Not secure” on the dev server), set Spatial data to Allow, then reload this page.',
    'error',
  ],
  'no-room': [
    'No room setup was found. In the headset open Settings › Physical space › Space setup, then enter AR again.',
    'error',
  ],
  'no-table': [
    'No table was found in your room setup. Add one in Settings › Physical space › Space setup (label it Table), then enter AR again.',
    'error',
  ],
};

export function initApp() {
  const ui = {
    button: document.getElementById('enter-ar'),
    status: document.getElementById('status'),
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.id = 'xr-canvas';
  document.body.appendChild(renderer.domElement);

  // scene.background stays null: Quest composites passthrough behind transparent pixels.
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.6, 2, 0.8);
  scene.add(sun);

  const { anchor, cube } = createTableCube();
  scene.add(anchor);
  // Cube look, driven by the right controller: thumbstick spins it, holding A cycles the hue.
  const cubeHsl = cube.material.color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  let spinDirection = -1;

  const panel = new StatusPanel(renderer);
  scene.add(panel.mesh);

  const tracker = new TableTracker();
  let activeReferenceSpaceType = null;
  let startError = null; // set when setSession fails, so 'sessionend' doesn't hide the reason
  const run = {
    startTime: null,
    lastTime: null,
    candidates: [],
    viewer: null,
    lockedKey: null,
    lockedAt: 0,
    seenAt: null, // when the cube was first in view since the last table change
    roomCaptureUsed: false,
    state: 'idle',
  };

  window.addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return; // three ignores setSize while presenting
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- Entering and leaving AR ----------

  async function startAR() {
    if (renderer.xr.isPresenting) return;
    startError = null;
    setButton('Starting…', true);
    let xrSession;
    try {
      xrSession = await navigator.xr.requestSession('immersive-ar', SESSION_INIT);
    } catch (err) {
      setButton('Enter AR', false);
      setStatus(`Couldn't start AR: ${err.message || err.name}`, 'error');
      return;
    }

    // local-floor keeps "up" and the floor stable; plain 'local' is the fallback.
    let referenceSpaceType = 'local-floor';
    try {
      await xrSession.requestReferenceSpace('local-floor');
    } catch {
      referenceSpaceType = 'local';
    }
    renderer.xr.setReferenceSpaceType(referenceSpaceType); // must precede setSession
    activeReferenceSpaceType = referenceSpaceType;

    try {
      await renderer.xr.setSession(xrSession);
    } catch (err) {
      console.error('renderer.xr.setSession failed:', err);
      startError = `Couldn't start AR: ${err.message || err.name}`;
      setButton('Enter AR', false);
      setStatus(startError, 'error');
      xrSession.end().catch(() => {}); // three's own 'end' listener still fires 'sessionend'
      return;
    }
    xrSession.addEventListener('select', onSelect);
  }

  function endAR() {
    renderer.xr.getSession()?.end();
  }

  renderer.xr.addEventListener('sessionstart', () => {
    Object.assign(run, {
      startTime: null,
      lastTime: null,
      candidates: [],
      viewer: null,
      lockedKey: null,
      lockedAt: 0,
      seenAt: null,
      roomCaptureUsed: false,
      state: 'scanning',
    });
    tracker.reset();
    setButton('Exit AR', false);
    setStatus('AR session running.', 'info');
  });

  renderer.xr.addEventListener('sessionend', () => {
    const endedIn = run.state;
    // XRPlane/XRMesh objects (and their spaces) die with the session.
    tracker.reset();
    run.candidates = [];
    run.state = 'idle';
    anchor.visible = false;
    panel.show(null);
    setButton('Enter AR', false);
    if (startError) {
      setStatus(startError, 'error');
    } else {
      const [text, tone] = EXIT_HINTS[endedIn] ?? ['Session ended. Enter AR again whenever you like.', 'info'];
      setStatus(text, tone);
    }
  });

  // Trigger or pinch: next table when there are several, otherwise offer Space Setup.
  function onSelect() {
    const xrSession = renderer.xr.getSession();
    if (!xrSession) return;
    if (run.candidates.length > 1) {
      tracker.next(run.candidates, run.viewer);
      return;
    }
    if ((run.state === 'no-room' || run.state === 'no-table') && canRunRoomCapture(xrSession)) {
      run.roomCaptureUsed = true;
      xrSession.initiateRoomCapture().catch((err) => console.warn('initiateRoomCapture failed:', err));
    }
  }

  function canRunRoomCapture(xrSession) {
    return (
      !run.roomCaptureUsed &&
      typeof xrSession.initiateRoomCapture === 'function' &&
      hasFeature(xrSession, 'plane-detection')
    );
  }

  // ---------- Per-frame work ----------

  renderer.setAnimationLoop((time, frame) => {
    if (!frame) return; // nothing to draw on the 2D page
    onXRFrame(time, frame);
    renderer.render(scene, camera);
  });

  function onXRFrame(time, frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    const xrSession = frame.session;
    if (run.startTime === null) run.startTime = time;
    const dt = run.lastTime === null ? 0 : Math.min((time - run.lastTime) / 1000, 0.1);
    run.lastTime = time;

    const viewerPose = frame.getViewerPose(refSpace);
    if (viewerPose) {
      const p = viewerPose.transform.position;
      const m = viewerPose.transform.matrix; // forward is the view's -Z axis
      run.viewer = { x: p.x, y: p.y, z: p.z, forward: { x: -m[8], y: -m[9], z: -m[10] } };
    }

    const { candidates, sceneObjectCount } = findTables(frame, refSpace);
    run.candidates = candidates;
    const table = tracker.update(candidates, run.viewer);

    if (table) {
      placeCube(table.top);
      if (tracker.lockedKey !== run.lockedKey) {
        run.lockedKey = tracker.lockedKey;
        run.lockedAt = time;
        run.seenAt = null;
      }
      if (run.seenAt === null && run.viewer && viewAngleTo(cubeCentre(table.top), run.viewer) <= SEEN_ANGLE) {
        run.seenAt = time;
      }
    } else {
      anchor.visible = false;
      run.lockedKey = null;
    }

    applyControllerInput(readRightController(xrSession.inputSources), dt);

    run.state = describeState({
      table,
      time,
      sceneObjectCount,
      spatialAllowed: hasFeature(xrSession, 'plane-detection') || hasFeature(xrSession, 'mesh-detection'),
    });
    panel.show(messageFor(run.state, xrSession, time, table));
    panel.follow(viewerPose, dt);
  }

  function findTables(frame, refSpace) {
    const planes = [];
    const meshes = [];
    let sceneObjectCount = 0;

    for (const plane of frame.detectedPlanes ?? []) {
      sceneObjectCount++;
      if (!isTableLabel(plane.semanticLabel) || plane.orientation === 'vertical') continue;
      const pose = frame.getPose(plane.planeSpace, refSpace);
      const top = pose && tableTopFromPlane(plane.polygon, pose.transform.matrix);
      if (top) planes.push({ key: plane, top });
    }
    for (const mesh of frame.detectedMeshes ?? []) {
      sceneObjectCount++;
      if (!isTableLabel(mesh.semanticLabel)) continue;
      const pose = frame.getPose(mesh.meshSpace, refSpace);
      const top = pose && tableTopFromMesh(mesh.vertices, pose.transform.matrix);
      if (top) meshes.push({ key: mesh, top });
    }

    // Quest reports each table twice (top plane + volume mesh); planes are exact,
    // meshes are only a fallback for when planes aren't available.
    return { candidates: planes.length > 0 ? planes : meshes, sceneObjectCount };
  }

  function applyControllerInput(controller, dt) {
    if (!controller) return;
    const spin = spinVelocity(controller.stick, spinDirection);
    spinDirection = spin.direction;
    cube.rotation.y += spin.velocity * dt; // about the cube's own vertical axis, on top of the table's yaw
    if (controller.aPressed) {
      cubeHsl.h = nextHue(cubeHsl.h, dt); // the colour stays where it is when A is released
      cube.material.color.setHSL(cubeHsl.h, cubeHsl.s, cubeHsl.l, THREE.SRGBColorSpace);
    }
  }

  function cubeEdge(top) {
    return Math.min(CUBE_EDGE, Math.min(top.width, top.depth) * MAX_EDGE_FRACTION);
  }

  function cubeCentre(top) {
    return { x: top.center.x, y: top.center.y + SURFACE_GAP + cubeEdge(top) / 2, z: top.center.z };
  }

  function placeCube(top) {
    const edge = cubeEdge(top);
    anchor.position.set(top.center.x, top.center.y + SURFACE_GAP, top.center.z); // reference-space up
    anchor.rotation.set(0, top.yaw, 0);
    anchor.scale.setScalar(edge / CUBE_EDGE);
    anchor.visible = true;
  }

  function describeState({ table, time, sceneObjectCount, spatialAllowed }) {
    if (table) return 'placed';
    if (!spatialAllowed) return 'no-permission';
    if (time - run.startTime < SCAN_GRACE_MS) return 'scanning';
    return sceneObjectCount === 0 ? 'no-room' : 'no-table';
  }

  function messageFor(state, xrSession, time, table) {
    const captureHint = canRunRoomCapture(xrSession)
      ? 'Pull the trigger or pinch to open Space Setup.'
      : 'Exit AR and use Settings › Physical space › Space setup.';
    switch (state) {
      case 'scanning':
        return { title: 'Looking for a table…', lines: ['Reading your room setup.'] };
      case 'no-permission':
        return {
          title: 'Spatial data is blocked',
          lines: [
            'Exit AR, tap the icon left of the address bar',
            '(a lock, or “Not secure” on the dev server),',
            'set Spatial data to Allow, then reload.',
          ],
        };
      case 'no-room':
        return { title: 'No room setup found', lines: ['Scan your room so the app can find a table.', captureHint] };
      case 'no-table':
        return { title: 'No table in your room setup', lines: ['Add a table (and label it Table) in Space Setup.', captureHint] };
      case 'placed': {
        // Stay up until the user has actually seen the cube, then a few more seconds.
        if (run.seenAt !== null && time - run.seenAt > PLACED_HINT_MS) return null;
        const count = run.candidates.length;
        const lines = [];
        if (run.seenAt === null) lines.push(directionHint(cubeCentre(table.top)));
        lines.push('Right stick spins it. Hold A to change colour.');
        if (count > 1) {
          lines.push('Pull the trigger or pinch for the next table.');
          const index = tracker.indexOf(run.candidates, run.viewer) + 1;
          return { title: `Table ${index} of ${count}`, lines };
        }
        if (run.seenAt !== null) lines.push('It sits at the centre of your table.');
        return { title: 'Cube placed', lines };
      }
      default:
        return null;
    }
  }

  function directionHint(point) {
    const bearing = bearingTo(point, run.viewer);
    if (bearing === null) return 'Look around to find it.';
    if (Math.abs(bearing) > (3 * Math.PI) / 4) return 'It’s behind you.';
    if (Math.abs(bearing) <= SEEN_ANGLE) return point.y < run.viewer.y ? 'Look down to find it.' : 'Look up to find it.';
    return bearing > 0 ? 'Turn right to find it.' : 'Turn left to find it.';
  }

  // ---------- 2D page ----------

  function setButton(label, disabled) {
    ui.button.textContent = label;
    ui.button.disabled = disabled;
  }

  function setStatus(text, tone = 'info') {
    ui.status.textContent = text;
    ui.status.dataset.tone = tone;
  }

  ui.button.addEventListener('click', () => (renderer.xr.isPresenting ? endAR() : startAR()));

  checkSupport().then(({ ok, message }) => {
    setButton(ok ? 'Enter AR' : 'AR unavailable', !ok);
    setStatus(message, ok ? 'info' : 'error');
  });

  const api = {
    startAR,
    endAR,
    selectNext: onSelect,
    snapshot: () => ({
      presenting: renderer.xr.isPresenting,
      state: run.state,
      tableCount: run.candidates.length,
      tableIndex: tracker.indexOf(run.candidates, run.viewer),
      cube: {
        visible: anchor.visible,
        position: cube.getWorldPosition(new THREE.Vector3()).toArray(),
        edge: CUBE_EDGE * anchor.scale.x,
        yaw: anchor.rotation.y,
        spin: cube.rotation.y,
        color: `#${cube.material.color.getHexString(THREE.SRGBColorSpace)}`,
      },
      panel: panel.mesh.visible ? panel.key : null,
      enabledFeatures: renderer.xr.getSession()?.enabledFeatures ?? null,
      referenceSpaceType: renderer.xr.isPresenting ? activeReferenceSpaceType : null,
    }),
  };
  return api;
}

function createTableCube() {
  // `anchor` sits on the table surface; the cube rests on it with a soft contact shadow.
  const anchor = new THREE.Group();
  anchor.visible = false;

  const cube = new THREE.Mesh(
    new RoundedBoxGeometry(CUBE_EDGE, CUBE_EDGE, CUBE_EDGE, 4, CUBE_EDGE * 0.06),
    new THREE.MeshStandardMaterial({ color: 0x3d7bff, roughness: 0.35, metalness: 0.05 }),
  );
  cube.position.y = CUBE_EDGE / 2;
  anchor.add(cube);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(CUBE_EDGE * 1.9, CUBE_EDGE * 1.9),
    new THREE.MeshBasicMaterial({ map: createShadowTexture(), transparent: true, depthWrite: false, toneMapped: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.0005;
  anchor.add(shadow);

  return { anchor, cube };
}

function createShadowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.25)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function hasFeature(xrSession, feature) {
  // enabledFeatures is missing on old browsers; assume the feature may be there.
  const features = xrSession.enabledFeatures;
  return !features || features.includes(feature);
}

async function checkSupport() {
  if (!window.isSecureContext) {
    return { ok: false, message: 'WebXR needs a secure page. Open this site with https://.' };
  }
  if (!navigator.xr) {
    return { ok: false, message: 'WebXR isn’t available here. Open this page in Meta Quest Browser on a Quest 3.' };
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    return supported
      ? { ok: true, message: 'Ready. Make sure your room setup includes a table.' }
      : { ok: false, message: 'This device or browser doesn’t support passthrough AR.' };
  } catch {
    return { ok: false, message: 'AR isn’t allowed on this page.' };
  }
}
