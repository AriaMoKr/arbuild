import * as THREE from 'three';
import { StatusPanel } from './statusPanel.js';
import { XrMenu } from './xrMenu.js';
import { FrameTrace } from './frameTrace.js';
import { DIG_CYCLE_S, DIG_KEYS, SITE_UNIT, createDigSite, digPose } from './digSite.js';
import { STYLES } from './styles.js';
import { heapRadius, noTread, treadMarks } from './groundMarks.js';
import { GROUND_TOLERANCE, SoftOcclusion } from './occlusion.js';
import { SiteSound } from './siteSound.js';
import { PlacementMemory } from './placementMemory.js';
import { LOOKAHEADS_S, limbSwing, nearestThreat, predictPoints, standingAt, stepWorker } from './worker.js';
import { nextHue, readLeftStick, readRightController, viewerHeading } from './controllerInput.js';
import {
  STEERING_MODES,
  driveLoad,
  fits,
  forwardOf,
  intoFrame,
  outOfFrame,
  parkedAt,
  settle,
  stepDrive,
  wrapAngle,
} from './excavatorDrive.js';
import {
  TableTracker,
  bearingTo,
  findRemembered,
  isTableLabel,
  quarterTurnToward,
  snapQuarterTurn,
  tableTopFromMesh,
  tableTopFromPlane,
  viewAngleTo,
} from './tableLocator.js';

const SITE_FIT = 0.9; // the dig site's footprint circle spans at most 90% of the table's shorter side
const SURFACE_GAP = 0.001; // avoid z-fighting with the real table surface
const SCAN_GRACE_MS = 3000; // Meta: scene data can take 2-3 s to arrive after the session starts
const PLACED_HINT_MS = 4000; // how long the 'placed' hint stays up once the site has been seen
const SEEN_ANGLE = (40 * Math.PI) / 180; // site within this angle of the gaze counts as seen
const STEERING_KEY = 'tableCube.steering'; // localStorage: 'relative' (default) or 'absolute'
const PAINT_KEY = 'tableCube.paintHue'; // localStorage: the excavator's paint hue, 0..1
const LOOK_KEY = 'tableCube.look'; // localStorage: the dig site's look, one of LOOK_NAMES
const LOOK_NAMES = ['diorama', 'plain']; // the menu's Look button goes round these; the first is the default
const WORKER_HEIGHT = 260; // design units: arm points higher than this pass over the worker's head
const ARM_THREAT_RADIUS = 25; // design units round each arm point the worker keeps clear of

// Scene features stay optional: if the user denies spatial data, the session still starts
// and we can explain what's wrong instead of failing to enter AR at all.
const SESSION_INIT = {
  requiredFeatures: [],
  // 'anchors' lets the dig site be remembered between sessions (src/placementMemory.js).
  optionalFeatures: ['local-floor', 'plane-detection', 'mesh-detection', 'hand-tracking', 'depth-sensing', 'anchors'],
  // Occlusion: gpu-optimized depth lets real things in front of the dig site (hands,
  // objects) hide it (src/occlusion.js). An empty format list lets the browser pick its
  // native format (same as three's own depth-sensing example).
  depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] },
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
  // The dig site in each look (src/styles.js): diorama and plain, switched on the menu, or
  // one sketch picked with ?style= on the dev server. All are built up front, so switching
  // in AR compiles and uploads nothing; `dig` is the one shown.
  const devStyle = import.meta.env.DEV ? new URLSearchParams(location.search).get('style') : null;
  const lookNames = STYLES.includes(devStyle) ? [devStyle] : LOOK_NAMES;
  const digs = new Map(lookNames.map((name) => [name, createDigSite({ style: name })]));
  let lookName = lookNames.includes(loadString(LOOK_KEY)) ? loadString(LOOK_KEY) : lookNames[0];
  let dig = digs.get(lookName);
  // Real things in front of the dig site hide it, softly (src/occlusion.js).
  const occlusion = new SoftOcclusion(renderer);
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('occlusion') === 'debug') occlusion.debug = true;
  for (const d of digs.values()) {
    d.site.traverse((o) => {
      // Things lying flat on the table hide behind anything on it, even a controller.
      if (o.isMesh || o.isLine) occlusion.apply(o.material, o.userData.ground ? { tolerance: GROUND_TOLERANCE } : undefined);
    });
    d.site.visible = d === dig;
    anchor.add(d.site);
  }
  scene.add(anchor);
  // Holding B on the right controller cycles the excavator's paint. The hue is remembered
  // and shared by the looks; each keeps its own saturation and lightness.
  const paintShades = new Map([...digs.values()].map((d) => [d, d.paint.color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)]));
  const savedHue = loadNumber(PAINT_KEY);
  let paintHue = savedHue !== null && savedHue >= 0 && savedHue < 1 ? savedHue : null; // null: each look's own colour
  applyPaint();
  // How the left stick steers (src/excavatorDrive.js), switched on the menu and remembered.
  let steering = loadSteering();
  // The table the site was on and everything on it, kept between sessions.
  const memory = new PlacementMemory();

  const panel = new StatusPanel();
  scene.add(panel.mesh);

  // Exit AR / Reload page / "Updated …", above the left hand (src/xrMenu.js).
  // Engine, hydraulics and rocks, from the excavator (src/siteSound.js).
  const sound = new SiteSound({ emitter: dig.excavator, camera });

  const menu = new XrMenu({
    onExit: () => endAR(),
    onReload: () => location.reload(),
    onSound: () => {
      sound.toggleMuted();
      showSoundLabel();
    },
    onSteering: () => {
      steering = STEERING_MODES[(STEERING_MODES.indexOf(steering) + 1) % STEERING_MODES.length];
      saveStorage(STEERING_KEY, steering);
      showSteeringLabel();
      console.info(`[drive] steering: ${steering}`);
    },
    onLook: () => setLook(lookNames[(lookNames.indexOf(lookName) + 1) % lookNames.length]),
    // Back to how the dig site started, on the same table (the remembered one is replaced).
    onReset: () => {
      resetSite();
      console.info('[memory] the dig site was reset');
    },
  });
  const showSoundLabel = () => menu.setLabel('sound', sound.muted ? 'Sound off' : 'Sound on');
  const showSteeringLabel = () => menu.setLabel('steering', `Steering: ${steering}`);
  const showLookLabel = () => menu.setLabel('look', `Look: ${lookName}`);
  showSoundLabel();
  showSteeringLabel();
  showLookLabel();
  scene.add(menu.root);

  const tracker = new TableTracker();
  let activeReferenceSpaceType = null;
  let startError = null; // set when setSession fails, so 'sessionend' doesn't hide the reason
  const run = {
    startTime: null,
    lastTime: null,
    candidates: [],
    viewer: null,
    lockId: null, // tracker.lockId of the table the site is on; a change means a new table
    lockedAt: 0,
    seenAt: null, // when the site was first in view since the last table change
    drive: parkedAt(dig.home), // where the excavator is and how it's moving (src/excavatorDrive.js)
    digTime: 0, // seconds into the dig cycle: it only runs while A is held
    digging: false,
    lastPhase: digPose(0).phase, // the dig phase last frame: scoops and dumps happen as it changes
    load: 0, // how full the bucket is with earth, 0..1 (src/groundMarks.js heaps)
    loadBefore: 0, // what it held when the scoop started
    scooped: 0, // what the scoop is taking, in loads
    dumping: 0, // what the dump is letting out
    worker: standingAt(dig.workerHome), // where the worker is and what he's doing (src/worker.js)
    tread: noTread(), // how far each wheel row has rolled since its last track mark (src/groundMarks.js)
    restored: false, // the site was put back as it was saved in an earlier session
    repainting: false,
    roomCaptureUsed: false,
    state: 'idle',
    sceneObjectCount: 0,
    depthSince: null, // frame time of the first depth frame (occlusion), for the debug log
  };
  // Frame timing over the last second, for the debug channel's snapshots.
  const frameStats = { since: null, last: null, count: 0, worstMs: 0, fps: null, worstFrameMs: null };

  window.addEventListener('pagehide', () => memory.flush()); // Reload, or the browser closing

  window.addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return; // three ignores setSize while presenting
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- Entering and leaving AR ----------

  async function startAR() {
    if (renderer.xr.isPresenting) return;
    sound.start(); // browsers only start audio inside a user gesture: this click
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
    // 'visible', 'visible-blurred' (a system menu is up) or 'hidden' (e.g. the headset is off).
    xrSession.addEventListener('visibilitychange', () => {
      console.info(`[session] visibility: ${xrSession.visibilityState}`);
      if (xrSession.visibilityState === 'hidden') memory.flush(); // the headset may be off for good
    });
    console.info(
      hasFeature(xrSession, 'depth-sensing') && xrSession.enabledFeatures
        ? `[depth] depth sensing on: ${xrSession.depthUsage}, ${xrSession.depthDataFormat}`
        : '[depth] depth sensing not available: no occlusion',
    );
  }

  function endAR() {
    renderer.xr.getSession()?.end();
  }

  // Frame timing for the first seconds of each session, logged as one '[startup]' line.
  const startupTrace = new FrameTrace();

  renderer.xr.addEventListener('sessionstart', () => {
    startupTrace.start(performance.now());
    occlusion.reset();
    Object.assign(run, {
      startTime: null,
      lastTime: null,
      candidates: [],
      viewer: null,
      lockId: null,
      lockedAt: 0,
      seenAt: null,
      digging: false,
      restored: false,
      repainting: false,
      roomCaptureUsed: false,
      state: 'scanning',
      sceneObjectCount: 0,
      depthSince: null,
    });
    resetSite();
    Object.assign(frameStats, { since: null, last: null, count: 0, worstMs: 0, fps: null, worstFrameMs: null });
    tracker.reset();
    memory.start(renderer.xr.getSession(), performance.now());
    setButton('Exit AR', false);
    setStatus('AR session running.', 'info');
  });

  renderer.xr.addEventListener('sessionend', () => {
    const endedIn = run.state;
    memory.end(); // saves the dig site as it is now
    // XRPlane/XRMesh objects (and their spaces) die with the session.
    tracker.reset();
    run.candidates = [];
    run.state = 'idle';
    anchor.visible = false;
    panel.show(null);
    menu.hide();
    sound.stop();
    setButton('Enter AR', false);
    if (startError) {
      setStatus(startError, 'error');
    } else {
      const [text, tone] = EXIT_HINTS[endedIn] ?? ['Session ended. Enter AR again whenever you like.', 'info'];
      setStatus(text, tone);
    }
  });

  // Trigger or pinch: presses a menu button when pointing at one; otherwise the next table
  // when there are several, or Space Setup when there's no table.
  function onSelect(event) {
    const xrSession = renderer.xr.getSession();
    if (!xrSession) return;
    if (event?.frame && event.inputSource) {
      const button = menu.buttonFor(event.frame, event.inputSource, renderer.xr.getReferenceSpace());
      if (button) {
        menu.press(button);
        return;
      }
    }
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
    const t0 = performance.now();
    onXRFrame(time, frame);
    const t1 = performance.now();
    occlusion.update(run.views?.[0]);
    if (import.meta.env.DEV) run.occlusionUniforms = occlusion.uniforms; // for debugging from the console
    renderer.render(scene, camera);
    const summary = startupTrace.record(time, t1 - t0, performance.now() - t1);
    if (summary) console.info(`[startup] ${summary}`);
  });

  function onXRFrame(time, frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    const xrSession = frame.session;
    if (run.startTime === null) run.startTime = time;
    const dt = run.lastTime === null ? 0 : Math.min((time - run.lastTime) / 1000, 0.1);
    run.lastTime = time;
    recordFrame(time);
    if (run.depthSince === null && renderer.xr.hasDepthSensing()) {
      run.depthSince = time;
      console.info(`[depth] first depth frame ${Math.round(time - run.startTime)} ms into the session: occlusion active`);
    }

    const viewerPose = frame.getViewerPose(refSpace);
    run.views = viewerPose?.views ?? null;
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
    menu.update(frame, refSpace, run.viewer);

    const { candidates, sceneObjectCount } = findTables(frame, refSpace);
    run.candidates = candidates;
    run.sceneObjectCount = sceneObjectCount;
    const remembered = memory.locate(frame, refSpace, time);
    let table = null;
    // While the saved dig site's anchor is being looked for, don't put the site anywhere else.
    if (!remembered.pending) {
      table = tracker.update(candidates, run.viewer, time); // `time` lets it ride out brief dropouts
      // The remembered table wins over an automatic pick, never over a table the user chose.
      if (remembered.pose && tracker.provisional) {
        const match = findRemembered(candidates, remembered.pose);
        if (match) table = tracker.lockTo(match, run.viewer, 'remembered');
      }
    }
    const recovery = tracker.takeRecovery();
    if (recovery) {
      const how = recovery.newObject ? ' as a new object in the same place' : '';
      console.info(`[tables] table back after ${Math.round(recovery.missingMs)} ms${how}; the site stayed put`);
    }
    const right = readRightController(xrSession.inputSources);
    repaint(right, dt);

    if (table) {
      if (tracker.lockId !== run.lockId) {
        run.lockId = tracker.lockId;
        run.lockedAt = time;
        run.seenAt = null;
        // Each table keeps its own dig site (src/placementMemory.js): one the user has
        // worked on comes back turned as it was, with everything where they left it. A
        // table without one starts with the site at its centre, square to the table and
        // facing the user, the excavator parked at home and the rocks in their pile.
        const kept = memory.siteFor(anchorPosition(table.top));
        if (kept && kept === memory.current) {
          // The same site, back after its table dropped out for a while (the headset was
          // off): what's in hand is newer than anything saved.
          dig.site.rotation.y = snapQuarterTurn(kept.pose.yaw - table.top.yaw);
        } else if (kept?.state) {
          memory.select(kept); // saves the site being left first
          dig.site.rotation.y = snapQuarterTurn(kept.pose.yaw - table.top.yaw);
          applySiteState(kept.state);
          run.restored = true;
          console.info('[memory] put the dig site back as it was');
        } else {
          memory.select(kept ?? null);
          dig.site.rotation.y = quarterTurnToward(run.viewer, table.top.center, table.top.yaw);
          resetSite();
        }
        logTablePick(table, candidates);
      }
      driveExcavator(readLeftStick(xrSession.inputSources), right, table.top, dt);
      run.digging = Boolean(right?.aPressed);
      if (run.digging) run.digTime += dt; // holding A digs; letting go stops the arm where it is
      placeSite(table.top);
      run.digPose = dig.animate(time / 1000, run.digTime);
      moveRocks(table.top, dt);
      moveWorker(table.top, dt);
      if (run.digging) tracker.confirm(); // the user is working with this table: keep it
      if (!tracker.provisional) {
        const at = anchorPosition(table.top);
        memory.keep(frame, refSpace, { ...at, yaw: table.top.yaw + dig.site.rotation.y }, siteState, time);
      }
      if (run.seenAt === null && run.viewer && viewAngleTo(siteCentre(table.top), run.viewer) <= SEEN_ANGLE) {
        run.seenAt = time;
      }
    } else {
      anchor.visible = false;
      run.digPose = null;
      run.lockId = null;
    }

    run.state = describeState({
      table,
      time,
      sceneObjectCount,
      spatialAllowed: hasFeature(xrSession, 'plane-detection') || hasFeature(xrSession, 'mesh-detection'),
    });
    panel.show(messageFor(run.state, xrSession, time, table));
    panel.follow(viewerPose, dt);
    sound.update(run.digPose && { ...run.digPose, hydraulics: workLoad() }, anchor.visible);
  }

  // How hard the excavator is working, 0..1, for the engine and hydraulics sound: the arm
  // while it digs, the wheels and the swing while they move.
  function workLoad() {
    return Math.max(run.digging ? run.digPose.hydraulics : 0, driveLoad(run.drive));
  }

  function recordFrame(time) {
    if (frameStats.since === null) {
      frameStats.since = frameStats.last = time;
      return;
    }
    frameStats.worstMs = Math.max(frameStats.worstMs, time - frameStats.last);
    frameStats.last = time;
    frameStats.count++;
    if (time - frameStats.since >= 1000) {
      frameStats.fps = Math.round((frameStats.count * 1000) / (time - frameStats.since));
      frameStats.worstFrameMs = round(frameStats.worstMs, 1);
      Object.assign(frameStats, { since: time, count: 0, worstMs: 0 });
    }
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

  // Holding B cycles the excavator's paint; the colour stays where it is when B is
  // released, and is remembered.
  function repaint(controller, dt) {
    const pressed = Boolean(controller?.bPressed);
    if (run.repainting && !pressed) saveStorage(PAINT_KEY, String(paintHue));
    run.repainting = pressed;
    if (!pressed) return;
    paintHue = nextHue(paintHue ?? paintShades.get(dig).h, dt);
    applyPaint();
  }

  // Every look's paint takes the chosen hue, in its own shade.
  function applyPaint() {
    if (paintHue === null) return;
    for (const [d, shade] of paintShades) d.paint.color.setHSL(paintHue, shade.s, shade.l, THREE.SRGBColorSpace);
  }

  // Shows the dig site in another look, with everything on it as it was.
  function setLook(name) {
    if (!digs.has(name) || name === lookName) return;
    const state = siteState();
    const { restored } = run;
    const spin = dig.site.rotation.y;
    dig.site.visible = false;
    dig = digs.get(name);
    lookName = name;
    dig.site.rotation.y = spin;
    dig.site.visible = true;
    applySiteState(state);
    run.restored = restored;
    sound.setEmitter(dig.excavator);
    saveStorage(LOOK_KEY, name);
    showLookLabel();
    console.info(`[look] ${name}`);
  }

  // The dig site as it was built: the excavator parked with its arm at rest, the rocks in
  // their pile and the worker where he stood.
  function resetSite() {
    run.restored = false; // whatever was put back is gone now
    run.drive = parkedAt(dig.home);
    run.digTime = 0;
    run.lastPhase = digPose(0).phase;
    dig.rocks.reset();
    dig.marks.tracks.reset();
    dig.marks.spills.reset();
    dig.marks.heaps.reset();
    run.load = run.loadBefore = run.scooped = run.dumping = 0;
    dig.setLoad(0);
    run.tread = noTread();
    run.worker = standingAt(dig.workerHome);
    dig.setDrive(run.drive);
    dig.setWorker(run.worker);
  }

  // Everything on the dig site that's remembered between sessions (src/placementMemory.js),
  // in the site's model frame.
  function siteState() {
    const d = run.drive;
    return {
      excavator: { x: d.x, z: d.z, heading: wrapAngle(d.heading), swing: wrapAngle(d.swing), digTime: run.digTime % DIG_CYCLE_S },
      rocks: dig.rocks.state(),
      worker: { x: run.worker.x, z: run.worker.z, facing: run.worker.facing },
      tracks: dig.marks.tracks.state(),
      spills: dig.marks.spills.state(),
      heaps: dig.marks.heaps.state(),
      load: round(run.load, 2),
    };
  }

  // Puts a saved siteState() back; whatever doesn't make sense starts as built.
  function applySiteState(saved) {
    resetSite();
    const e = saved?.excavator;
    if (e && ['x', 'z', 'heading', 'swing', 'digTime'].every((k) => Number.isFinite(e[k]))) {
      run.drive = { ...parkedAt({ x: e.x, z: e.z, heading: e.heading }), swing: e.swing };
      run.digTime = Math.max(0, e.digTime);
      run.lastPhase = digPose(run.digTime).phase; // no scoop or dump just for coming back
    }
    dig.marks.heaps.restore(saved?.heaps); // before the rocks: they may rest on them
    dig.rocks.restore(saved?.rocks);
    dig.marks.tracks.restore(saved?.tracks);
    dig.marks.spills.restore(saved?.spills);
    run.load = run.loadBefore = Number.isFinite(saved?.load) ? Math.min(1, Math.max(0, saved.load)) : 0;
    run.scooped = 0;
    run.dumping = run.lastPhase === 'dump' ? run.load : 0;
    dig.setLoad(run.load);
    const w = saved?.worker;
    if (w && ['x', 'z', 'facing'].every((k) => Number.isFinite(w[k]))) run.worker = standingAt(w);
    dig.setDrive(run.drive);
    dig.animate(0, run.digTime);
    dig.setWorker(run.worker);
  }

  // What the excavator mustn't drive into: the rocks lying about and the worker.
  function siteObstacles() {
    return [...dig.rocks.obstacles(), { x: run.worker.x, z: run.worker.z, r: dig.workerRadius }];
  }

  // The dig cycle moves rocks and earth. Starting a scoop picks up the top rock near the
  // teeth, and fills the bucket: out of a heap there, if there is one, else out of the
  // ground (a dug patch), as long as the teeth are over the table. The bucket empties over
  // the dump, and as it opens at the end the earth becomes a heap under it (joining one
  // that's there) and the rock falls, onto the heap or the table. Falling rocks land.
  function moveRocks(top, dt) {
    const phase = run.digPose.phase;
    const area = driveArea(top);
    const progress = (from, to) => {
      const [start, end] = [DIG_KEYS[from].t, DIG_KEYS[to].t];
      return Math.min(1, Math.max(0, ((run.digTime % DIG_CYCLE_S) - start) / (end - start)));
    };
    const smooth = (f) => f * f * (3 - 2 * f);
    if (phase !== run.lastPhase) {
      if (run.lastPhase === 'scoop') dig.rocks.carry(1); // the scoop's done: the rock rides in the bucket
      if (phase === 'scoop') {
        const teeth = dig.teeth();
        dig.rocks.scoop(teeth);
        run.loadBefore = run.load;
        run.scooped = 0;
        if (fits(teeth, 0, area)) {
          run.scooped = dig.marks.heaps.scoop(teeth.x, teeth.z, 1 - run.load);
          if (run.scooped > 0) {
            dig.rocks.settle(); // a rock that lay on the heap
          } else {
            run.scooped = 1 - run.load;
            // A dug patch where the bucket bit, turned the way the bucket faces.
            const d = run.drive;
            dig.marks.spills.add({ x: teeth.x, z: teeth.z, yaw: d.heading + d.swing, length: 110, width: 95, tone: 1 });
          }
        }
      }
      if (phase === 'dump') run.dumping = run.load;
      if (phase === 'return') {
        if (run.dumping > 0.05) {
          const under = dig.bucketInside();
          const spot = settle(under, heapRadius(run.dumping), area); // on the table
          dig.marks.heaps.add(spot.x, spot.z, run.dumping);
        }
        run.load = run.loadBefore = run.dumping = 0;
        dig.rocks.dump({ contains: (x, z, r) => settle({ x, z }, r, area) }); // it lands on the table, or the heap
      }
      run.lastPhase = phase;
    }
    if (phase === 'scoop') {
      const f = progress(1, 2);
      dig.rocks.carry(f);
      run.load = Math.min(1, run.loadBefore + run.scooped * smooth(f));
    }
    if (phase === 'dump') run.load = run.dumping * (1 - smooth(progress(3, 4)));
    dig.setLoad(run.load);
    for (const r of dig.rocks.update(dt)) {
      dig.marks.spills.add({ x: r.x, z: r.z, yaw: r.x * 0.07, length: r.w * 1.9, width: r.d * 1.9 }); // dirt where it lands
    }
  }

  // The worker watches the excavator and walks out of the way of its arm (low enough to
  // hit him), now or where the swing and the drive will take it, and of the machine itself.
  function moveWorker(top, dt) {
    const d = run.drive;
    const arm = dig.armPoints().filter((p) => p.y < WORKER_HEIGHT);
    const body = { x: d.x, z: d.z };
    const ahead = (points) => [points, ...LOOKAHEADS_S.map((s) => predictPoints(points, d, s))].flat();
    const threats = [
      ...ahead(arm).map((p) => ({ x: p.x, z: p.z, r: ARM_THREAT_RADIUS })),
      ...ahead([body]).map((p) => ({ x: p.x, z: p.z, r: dig.bodyRadius })),
    ];
    run.worker = stepWorker(
      run.worker,
      {
        threats,
        watch: body,
        radius: dig.workerRadius,
        area: driveArea(top),
        obstacles: [...dig.rocks.obstacles(), ...dig.marks.heaps.obstacles(), { ...body, r: dig.bodyRadius }],
      },
      dt,
    );
    dig.setWorker(run.worker, limbSwing(run.worker));
  }

  // The left stick drives the excavator round the table, the right stick swings its cab
  // (src/excavatorDrive.js). All of it happens in the site's own frame, in design units.
  function driveExcavator(leftStick, right, top, dt) {
    const worldHeading = run.viewer && viewerHeading(run.viewer.forward, run.viewer.up);
    const before = run.drive;
    run.drive = stepDrive(
      before,
      {
        stick: leftStick,
        swingStick: right?.stick ?? null,
        mode: steering,
        viewHeading: worldHeading && intoFrame(worldHeading, top.yaw + dig.site.rotation.y),
      },
      { area: driveArea(top), radius: dig.bodyRadius, obstacles: siteObstacles() },
      dt,
    );
    dig.setDrive(run.drive);
    // The tyres leave tracks, and flatten any heap of earth the machine drives through.
    const tread = treadMarks(before, run.drive, run.tread, dig.wheels);
    run.tread = tread.carry;
    for (const mark of tread.marks) dig.marks.tracks.add(mark);
    const d = run.drive;
    for (const heap of dig.marks.heaps.flatten(d.x, d.z, dig.bodyRadius * 0.75)) {
      const r = heapRadius(heap.loads);
      dig.marks.spills.add({ x: heap.x, z: heap.z, yaw: d.heading, length: r * 2.4, width: r * 2.2, tone: 0.5 });
      dig.rocks.settle(); // a rock that lay on it
    }
    if (d.x !== before.x || d.z !== before.z || d.heading !== before.heading || d.swing !== before.swing) tracker.confirm(); // keep this table
  }

  // The table top in the site's frame, for driving: centred on the site's origin, turned
  // by the site's quarter turn, in design units at the site's scale on this table.
  function driveArea(top) {
    const unitsPerMetre = 1 / (SITE_UNIT * siteScale(top));
    return {
      cx: dig.origin.x,
      cz: dig.origin.z,
      angle: dig.site.rotation.y,
      halfX: (top.width / 2) * unitsPerMetre,
      halfZ: (top.depth / 2) * unitsPerMetre,
    };
  }

  // For the debug log: which table was picked and why ('first', 'tables changed', 'table lost', 'user').
  function logTablePick(table, candidates) {
    const index = tracker.indexOf(candidates, run.viewer) + 1;
    const away = run.viewer && Math.hypot(table.top.center.x - run.viewer.x, table.top.center.z - run.viewer.z);
    console.info(`[tables] ${tracker.reason}: table ${index} of ${candidates.length}${away == null ? '' : `, ${away.toFixed(1)} m away`}`);
  }

  // Where the anchor goes: the table centre, just above its surface.
  function anchorPosition(top) {
    return { x: top.center.x, y: top.center.y + SURFACE_GAP, z: top.center.z };
  }

  function lockedTop() {
    return run.candidates.find((c) => c.key === tracker.lockedKey)?.top ?? null;
  }

  // Full size, or smaller when the table is too small for the site's footprint.
  function siteScale(top) {
    return Math.min(1, (Math.min(top.width, top.depth) * SITE_FIT) / (2 * dig.radius));
  }

  function siteCentre(top) {
    const base = anchorPosition(top);
    return { x: base.x, y: base.y + (dig.height * siteScale(top)) / 2, z: base.z };
  }

  function placeSite(top) {
    const { x, y, z } = anchorPosition(top);
    anchor.position.set(x, y, z); // lifted along reference-space up, never the plane normal
    anchor.rotation.set(0, top.yaw, 0);
    anchor.scale.setScalar(siteScale(top));
    anchor.visible = true;
  }

  // Where the excavator is and how it's moving, in the room and on the table (metres), for
  // the e2e test and the debug log.
  function excavatorSnapshot() {
    const top = lockedTop();
    const d = run.drive;
    const scale = top ? siteScale(top) : 1;
    const metres = SITE_UNIT * scale;
    const p = dig.excavator.getWorldPosition(new THREE.Vector3());
    const forward = outOfFrame(forwardOf(d.heading), anchor.rotation.y + dig.site.rotation.y); // site frame -> room
    const onTable = top && intoFrame({ x: p.x - top.center.x, z: p.z - top.center.z }, top.yaw);
    return {
      position: p.toArray(),
      forward: [forward.x, forward.z],
      heading: d.heading,
      swing: d.swing,
      speed: d.speed * metres,
      onTable: onTable && { x: onTable.x, z: onTable.z },
      limits: top && { x: Math.max(0, top.width / 2 - dig.bodyRadius * metres), z: Math.max(0, top.depth / 2 - dig.bodyRadius * metres) },
      radius: dig.bodyRadius * metres,
      blocked: Boolean(d.blocked),
      atHome: d.x === dig.home.x && d.z === dig.home.z && d.heading === dig.home.heading && d.swing === 0,
      // Gap between its body circle and the nearest of the worker and the rocks.
      clearance: Math.min(...siteObstacles().map((o) => Math.hypot(d.x - o.x, d.z - o.z) - dig.bodyRadius - o.r)) * metres,
      digTime: run.digTime,
      digging: run.digging,
      load: round(run.load, 2),
      steering,
    };
  }

  // The rocks in the model frame (design units: 0.5 mm at full size), and how many have
  // been moved from the pile they started in.
  function rocksSnapshot() {
    const state = dig.rocks.state();
    const moved = state.filter((s, i) => {
      const start = dig.rocks.initial[i];
      return s.carried || Math.hypot(s.x - start.x, s.z - start.z) > 5;
    }).length;
    return { state, moved, busy: dig.rocks.busy };
  }

  // Where the worker is (room, metres) and how close the excavator's arm is to him.
  function workerSnapshot() {
    const w = run.worker;
    const top = lockedTop();
    const metres = SITE_UNIT * (top ? siteScale(top) : 1);
    const arm = dig.armPoints().filter((p) => p.y < WORKER_HEIGHT).map((p) => ({ x: p.x, z: p.z, r: ARM_THREAT_RADIUS }));
    return {
      x: w.x,
      z: w.z,
      facing: w.facing,
      walking: Boolean(w.target),
      // Gap between him and the nearest low part of the arm, in metres.
      armGap: (nearestThreat(w, dig.workerRadius, arm)?.gap ?? Infinity) * metres,
    };
  }

  // World-space box round the site's solid parts (not its shadows), for the e2e test.
  function solidBounds() {
    const box = new THREE.Box3();
    dig.site.traverse((o) => {
      if (o.isMesh && !o.userData.shadow && !o.userData.ground) box.expandByObject(o, true);
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
        lines.push('Left stick drives, right stick swings the cab.');
        lines.push('Hold A to dig, B to repaint.');
        if (run.restored) lines.push('As you left it. Reset on the menu starts afresh.');
        if (count > 1) lines.push('Pull the trigger or pinch for the next table.');
        // Coming back to a remembered site says so, however many tables there are.
        if (run.restored) return { title: 'Your dig site is back', lines };
        if (count > 1) {
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

  // Enter AR stays disabled until the shaders are compiled too, so the session can't
  // start half-way through and stall on its first frames.
  Promise.all([checkSupport(), precompile()]).then(([{ ok, message }]) => {
    setButton(ok ? 'Enter AR' : 'AR unavailable', !ok);
    setStatus(message, ok ? 'info' : 'error');
  });

  // Compile every shader the AR scene uses, and upload its canvas textures, while the 2D
  // page is up. Otherwise the first AR frames stall: on the Quest the first second showed
  // a 70-90 ms frame. compile() includes hidden objects (the site before a table is found,
  // the menu, the panel), and AR renders with the same output colour space and tone
  // mapping, so these programs are reused as they are.
  async function precompile() {
    const start = performance.now();
    try {
      // compileAsync needs KHR_parallel_shader_compile, which Quest Browser lacks (three warns
      // about it every time); there, compile in one go instead.
      if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera);
      else renderer.compile(scene, camera);
      const textures = new Set();
      scene.traverse((o) => {
        if (o.material?.map) textures.add(o.material.map);
      });
      for (const texture of textures) renderer.initTexture(texture);
      const meshes = warmUpDraw();
      console.info(
        `[shaders] precompiled ${renderer.info.programs.length} shader programs, ${textures.size} textures and ${meshes} meshes in ${Math.round(performance.now() - start)} ms`,
      );
    } catch (err) {
      console.warn('Shader precompile failed; shaders will compile on first use instead:', err);
    }
  }

  // compile() doesn't upload geometry: on the Quest the frame where the dig site first
  // appeared still spent 35-46 ms rendering, and only in a freshly loaded page. So draw
  // the whole scene once, everything shown and nothing culled, into a 1x1-pixel scissor
  // box of the page's canvas (behind the 2D page, cleared straight after). That uploads
  // every mesh's buffers and creates its vertex arrays. The canvas has the same output
  // colour space as AR, so this reuses the compiled shaders. Returns the mesh count.
  function warmUpDraw() {
    const saved = [];
    let meshes = 0;
    scene.traverse((o) => {
      saved.push([o, o.visible, o.frustumCulled]);
      o.visible = true;
      o.frustumCulled = false;
      if (o.isMesh) meshes++;
    });
    try {
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, 1, 1);
      renderer.render(scene, camera);
    } finally {
      renderer.setScissorTest(false);
      renderer.clear();
      for (const [o, visible, culled] of saved) {
        o.visible = visible;
        o.frustumCulled = culled;
      }
    }
    return meshes;
  }

  const api = {
    startAR,
    endAR,
    selectNext: () => onSelect(),
    /** Turns depth occlusion off and back on, for comparing views in tests. */
    setOcclusion: (on) => {
      occlusion.enabled = Boolean(on);
    },
    /** Shows when the app last changed ("Updated …") on the in-AR menu. */
    setVersion: (text) => menu.setVersion(text),
    snapshot: () => ({
      presenting: renderer.xr.isPresenting,
      state: run.state,
      tableCount: run.candidates.length,
      tableIndex: tracker.indexOf(run.candidates, run.viewer),
      pick: { reason: tracker.reason, provisional: tracker.provisional },
      site: {
        visible: anchor.visible,
        position: anchor.getWorldPosition(new THREE.Vector3()).toArray(), // its base, on the table surface
        scale: anchor.scale.x,
        radius: dig.radius * anchor.scale.x,
        yaw: anchor.rotation.y,
        spin: dig.site.rotation.y,
        bounds: anchor.visible ? solidBounds() : null,
        color: `#${dig.paint.color.getHexString(THREE.SRGBColorSpace)}`,
        digPhase: run.digPose?.phase ?? null,
      },
      look: lookName,
      marks: { tracks: dig.marks.tracks.count, spills: dig.marks.spills.count, heaps: dig.marks.heaps.count, earth: round(dig.marks.heaps.loads, 2) },
      excavator: excavatorSnapshot(),
      rocks: rocksSnapshot(),
      worker: workerSnapshot(),
      memory: { ...memory.snapshot(), restored: run.restored },
      panel: panel.mesh.visible ? panel.key : null,
      xrVisibility: renderer.xr.getSession()?.visibilityState ?? null,
      depth: renderer.xr.isPresenting
        ? { usage: renderer.xr.getSession()?.depthUsage ?? null, format: renderer.xr.getSession()?.depthDataFormat ?? null, active: occlusion.active }
        : null,
      enabledFeatures: renderer.xr.getSession()?.enabledFeatures ?? null,
      referenceSpaceType: renderer.xr.isPresenting ? activeReferenceSpaceType : null,
      // Extra detail for the debug channel (src/debugChannel.js).
      programs: renderer.info.programs?.length ?? null, // should not grow after entering AR (see precompile)
      geometries: renderer.info.memory.geometries, // nor should this (see warmUpDraw)
      fps: frameStats.fps,
      worstFrameMs: frameStats.worstFrameMs,
      viewer: run.viewer ? [run.viewer.x, run.viewer.y, run.viewer.z].map((v) => round(v)) : null,
      sceneObjects: run.sceneObjectCount,
      tables: run.candidates.map((c) => ({
        from: 'planeSpace' in c.key ? 'plane' : 'mesh',
        label: c.key.semanticLabel ?? null,
        centre: [c.top.center.x, c.top.center.y, c.top.center.z].map((v) => round(v)),
        size: [round(c.top.width), round(c.top.depth)],
        yaw: round(c.top.yaw),
        locked: c.key === tracker.lockedKey,
      })),
      inputs: [...(renderer.xr.getSession()?.inputSources ?? [])].map(describeInput),
      menu: menu.snapshot(),
      sound: { state: sound.state, muted: sound.muted },
    }),
  };
  return api;
}

function loadSteering() {
  try {
    return localStorage.getItem(STEERING_KEY) === 'absolute' ? 'absolute' : 'relative';
  } catch {
    return 'relative'; // storage blocked
  }
}

/** A string saved under `key`, or null. */
function loadString(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked
  }
}

/** A number saved under `key`, or null. */
function loadNumber(key) {
  try {
    const value = Number.parseFloat(localStorage.getItem(key));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null; // storage blocked
  }
}

function saveStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: it lasts until the page reloads
  }
}

function round(value, digits = 3) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function describeInput(source) {
  const gamepad = source.gamepad;
  return {
    hand: source.handedness,
    kind: source.hand ? 'hand' : 'controller',
    mode: source.targetRayMode,
    profile: source.profiles?.[0] ?? null,
    gamepad: gamepad
      ? {
          mapping: gamepad.mapping,
          axes: [...gamepad.axes].map((v) => round(v, 2)),
          pressed: [...gamepad.buttons].flatMap((b, i) => (b.pressed ? [i] : [])),
        }
      : null,
  };
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
