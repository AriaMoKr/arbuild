import * as THREE from 'three';
import { StatusPanel } from './statusPanel.js';
import { createDigSite } from './digSite.js';
import {
  clampOffset,
  nextHue,
  readLeftStick,
  readRightController,
  slideOnTable,
  spinVelocity,
  tableOffsetToWorld,
  viewerHeading,
} from './controllerInput.js';
import {
  TableTracker,
  bearingTo,
  isTableLabel,
  quarterTurnToward,
  tableTopFromMesh,
  tableTopFromPlane,
  viewAngleTo,
} from './tableLocator.js';

const SITE_FIT = 0.9; // the dig site's footprint circle spans at most 90% of the table's shorter side
const SURFACE_GAP = 0.001; // avoid z-fighting with the real table surface
const SCAN_GRACE_MS = 3000; // Meta: scene data can take 2-3 s to arrive after the session starts
const PLACED_HINT_MS = 4000; // how long the 'placed' hint stays up once the site has been seen
const SEEN_ANGLE = (40 * Math.PI) / 180; // site within this angle of the gaze counts as seen

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

  // `anchor` sits on the table surface, turned to the table's yaw and scaled to fit it;
  // the dig site spins on top of it.
  const anchor = new THREE.Group();
  anchor.visible = false;
  const { site, paint, radius: siteRadius, height: siteHeight } = createDigSite();
  anchor.add(site);
  scene.add(anchor);
  // Driven by the right controller: thumbstick spins the site, holding A cycles the excavator's paint.
  const paintHsl = paint.color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
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
    seenAt: null, // when the site was first in view since the last table change
    offset: { x: 0, z: 0 }, // site position relative to the table centre, in the table's frame (left stick)
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
      offset: { x: 0, z: 0 },
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
      const m = viewerPose.transform.matrix;
      run.viewer = {
        x: p.x,
        y: p.y,
        z: p.z,
        forward: { x: -m[8], y: -m[9], z: -m[10] }, // the view's -Z axis
        up: { x: m[4], y: m[5], z: m[6] }, // the view's +Y axis
      };
    }

    const { candidates, sceneObjectCount } = findTables(frame, refSpace);
    run.candidates = candidates;
    const table = tracker.update(candidates, run.viewer);
    applyControllerInput(readRightController(xrSession.inputSources), dt);

    if (table) {
      if (tracker.lockedKey !== run.lockedKey) {
        run.lockedKey = tracker.lockedKey;
        run.lockedAt = time;
        run.seenAt = null;
        // A new table starts with the site at its centre, square to the table and facing the user.
        run.offset = { x: 0, z: 0 };
        site.rotation.y = quarterTurnToward(run.viewer, table.top.center, table.top.yaw);
      }
      moveSite(readLeftStick(xrSession.inputSources), table.top, dt);
      placeSite(table.top);
      if (run.seenAt === null && run.viewer && viewAngleTo(siteCentre(table.top), run.viewer) <= SEEN_ANGLE) {
        run.seenAt = time;
      }
    } else {
      anchor.visible = false;
      run.lockedKey = null;
    }

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
    site.rotation.y += spin.velocity * dt; // about the site's own vertical axis, on top of the table's yaw
    if (controller.aPressed) {
      paintHsl.h = nextHue(paintHsl.h, dt); // the colour stays where it is when A is released
      paint.color.setHSL(paintHsl.h, paintHsl.s, paintHsl.l, THREE.SRGBColorSpace);
    }
  }

  function moveSite(stick, top, dt) {
    if (!stick) return;
    const heading = run.viewer && viewerHeading(run.viewer.forward, run.viewer.up);
    run.offset = slideOnTable(run.offset, stick, heading, top.yaw, slideLimits(top), dt);
  }

  // How far the site may move from the table centre and still stand fully on the table
  // top, shadows included. Its footprint fits in a circle, so spinning it at an edge
  // never pushes it over.
  function slideLimits(top) {
    const r = siteRadius * siteScale(top);
    return { x: Math.max(0, top.width / 2 - r), z: Math.max(0, top.depth / 2 - r) };
  }

  // The offset actually shown: kept on the table even if the table's outline shrinks.
  function shownOffset(top) {
    return clampOffset(run.offset, slideLimits(top));
  }

  // Where the anchor goes: the table centre plus the site's offset.
  function anchorPosition(top) {
    const shift = tableOffsetToWorld(shownOffset(top), top.yaw);
    return { x: top.center.x + shift.x, y: top.center.y + SURFACE_GAP, z: top.center.z + shift.z };
  }

  function lockedTop() {
    return run.candidates.find((c) => c.key === tracker.lockedKey)?.top ?? null;
  }

  // Full size, or smaller when the table is too small for the site's footprint.
  function siteScale(top) {
    return Math.min(1, (Math.min(top.width, top.depth) * SITE_FIT) / (2 * siteRadius));
  }

  function siteCentre(top) {
    const base = anchorPosition(top);
    return { x: base.x, y: base.y + (siteHeight * siteScale(top)) / 2, z: base.z };
  }

  function placeSite(top) {
    const { x, y, z } = anchorPosition(top);
    anchor.position.set(x, y, z); // lifted along reference-space up, never the plane normal
    anchor.rotation.set(0, top.yaw, 0);
    anchor.scale.setScalar(siteScale(top));
    anchor.visible = true;
  }

  // World-space box round the site's solid parts (not its shadows), for the e2e test.
  function solidBounds() {
    const box = new THREE.Box3();
    site.traverse((o) => {
      if (o.isMesh && !o.userData.shadow) box.expandByObject(o, true);
    });
    return box3ToArrays(box);
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
        // Stay up until the user has actually seen the site, then a few more seconds.
        if (run.seenAt !== null && time - run.seenAt > PLACED_HINT_MS) return null;
        const count = run.candidates.length;
        const lines = [];
        if (run.seenAt === null) lines.push(directionHint(siteCentre(table.top)));
        lines.push('Left stick moves it, right stick spins it.');
        lines.push('Hold A to repaint the excavator.');
        if (count > 1) {
          lines.push('Pull the trigger or pinch for the next table.');
          const index = tracker.indexOf(run.candidates, run.viewer) + 1;
          return { title: `Table ${index} of ${count}`, lines };
        }
        if (run.seenAt !== null) lines.push('It starts at the centre of your table.');
        return { title: 'Excavator placed', lines };
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
      site: {
        visible: anchor.visible,
        position: anchor.getWorldPosition(new THREE.Vector3()).toArray(), // its base, on the table surface
        scale: anchor.scale.x,
        radius: siteRadius * anchor.scale.x,
        yaw: anchor.rotation.y,
        spin: site.rotation.y,
        offset: { ...run.offset },
        limits: lockedTop() ? slideLimits(lockedTop()) : null,
        bounds: anchor.visible ? solidBounds() : null,
        color: `#${paint.color.getHexString(THREE.SRGBColorSpace)}`,
      },
      panel: panel.mesh.visible ? panel.key : null,
      enabledFeatures: renderer.xr.getSession()?.enabledFeatures ?? null,
      referenceSpaceType: renderer.xr.isPresenting ? activeReferenceSpaceType : null,
    }),
  };
  return api;
}

function box3ToArrays(box) {
  return { min: box.min.toArray(), max: box.max.toArray() };
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
