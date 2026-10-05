// End-to-end check without a headset: runs the Vite dev server, drives headless
// Chrome over the DevTools protocol, emulates a Quest 3 in Meta's synthetic rooms
// (IWER + SEM) and checks where the dig site lands. Screenshots go to e2e-output/.
//
//   npm run test:e2e                 (set CHROME_PATH if Chrome/Edge isn't found)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'e2e-output');
const debugLogFile = path.join(outDir, 'debug-log.jsonl'); // written by the dev server in e2e mode
const SURFACE_GAP = 0.001;
const TOLERANCE = 0.01; // metres

// Table-top centres in local-floor coordinates, read from @iwer/sem's captures.
const MEETING_ROOM_TABLE = [0.069, 0.73, -1.572];
const MEETING_ROOM_TABLE_WIDTH = 1.239; // along x (the table is turned only ~0.6 degrees)
const MEETING_ROOM_TABLE_DEPTH = 2.145; // along z
const LIVING_ROOM_TABLES = [
  [1.26, 0.455, -0.403],
  [-1.539, 0.789, 0.204],
  [2.521, 0.612, 1.017],
  [-1.534, 0.775, -1.191],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  return found;
}

const CDP_TIMEOUT_MS = 30000;

async function launchBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'table-site-e2e-'));
  const proc = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--remote-debugging-port=0', // let the browser pick a free port; it's written to DevToolsActivePort
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      '--ignore-certificate-errors', // the dev server's self-signed cert
      '--enable-unsafe-swiftshader', // WebGL without a GPU
      '--autoplay-policy=no-user-gesture-required', // the sound starts without a real click
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => proc.once('exit', resolve));

  async function shutdown() {
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    // Chrome can hold files for a moment after exiting; retry before giving up.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  try {
    return await connect(profile, proc, shutdown);
  } catch (err) {
    await shutdown();
    throw err;
  }
}

async function connect(profile, proc, shutdown) {
  let target;
  for (let i = 0; i < 75 && !target; i++) {
    await sleep(200);
    if (proc.exitCode !== null) throw new Error(`Browser exited early with code ${proc.exitCode}.`);
    try {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {
      // not up yet
    }
  }
  if (!target) throw new Error('Browser did not expose a DevTools target.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('DevTools connection failed.')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer, method } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
  ws.addEventListener('close', () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('DevTools connection closed.'));
    }
    pending.clear();
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('DevTools connection closed.'));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${CDP_TIMEOUT_MS} ms`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? expression}`);
    }
    return res.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  return {
    problems,
    evaluate,
    async goto(url) {
      problems.length = 0;
      await send('Page.navigate', { url });
    },
    async waitFor(expression, { timeout = 15000, label = expression } = {}) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        try {
          last = await evaluate(expression);
          if (last) return last;
        } catch (err) {
          if (/connection closed/.test(err.message)) throw err;
          // otherwise the page is still loading
        }
        await sleep(100);
      }
      throw new Error(`Timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
    },
    async screenshot(name) {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
      return path.relative(root, file);
    },
    /** Counts the coloured pixels on screen: the dig site's. The room and the panel are grey. */
    async colouredPixels() {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      return evaluate(`(async () => {
        const image = await createImageBitmap(await (await fetch('data:image/png;base64,${res.data}')).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 20) count++;
        }
        return count;
      })()`);
    },
    async close() {
      await send('Browser.close').catch(() => {}); // graceful exit takes the child processes with it
      ws.close();
      await shutdown();
    },
  };
}

function assertNear(actual, expected, label) {
  const off = Math.hypot(...actual.map((v, i) => v - expected[i]));
  if (off > TOLERANCE) {
    throw new Error(`${label}: expected ≈ [${expected.join(', ')}], got [${actual.map((v) => v.toFixed(3)).join(', ')}]`);
  }
}

/** Where the dig site's base should be: on the table top, lifted by the surface gap. */
function siteBaseFor(tableTop) {
  return [tableTop[0], tableTop[1] + SURFACE_GAP, tableTop[2]];
}

/** Throws unless the site's solid parts lie within the meeting room table's outline (it's turned only ~0.6 degrees). */
function assertOnMeetingTable(site, label) {
  const [x, y, z] = MEETING_ROOM_TABLE;
  const { min, max } = site.bounds;
  const slack = 0.003; // the table's slight turn, over the site's footprint
  const inside =
    min[0] >= x - MEETING_ROOM_TABLE_WIDTH / 2 - slack &&
    max[0] <= x + MEETING_ROOM_TABLE_WIDTH / 2 + slack &&
    min[2] >= z - MEETING_ROOM_TABLE_DEPTH / 2 - slack &&
    max[2] <= z + MEETING_ROOM_TABLE_DEPTH / 2 + slack &&
    min[1] >= y - 0.005; // the rocks sit a few millimetres into the ground
  if (!inside) throw new Error(`${label}: site spans [${min.map((v) => v.toFixed(3))}] to [${max.map((v) => v.toFixed(3))}], off the table`);
}

function assertNoProblems(browser) {
  if (browser.problems.length) throw new Error(`Page errors:\n  ${browser.problems.join('\n  ')}`);
}

const snapshot = (b) => b.evaluate('window.__app.snapshot()');
const pct = (fraction) => `${Math.round(fraction * 100)}%`;

/** How much of the dig site depth occlusion leaves on screen: its pixels with and without. */
async function shownFraction(browser) {
  const shown = await browser.colouredPixels();
  await browser.evaluate('window.__app.setOcclusion(false)');
  await sleep(150);
  const all = await browser.colouredPixels();
  await browser.evaluate('window.__app.setOcclusion(true)');
  await sleep(150);
  if (all < 500) throw new Error(`the dig site is barely on screen (${all} px) even without occlusion`);
  return shown / all;
}

async function openApp(browser, base, query) {
  await browser.goto(`${base}?${query}`);
  await browser.waitFor('window.__app && !document.getElementById("enter-ar").disabled', { label: 'Enter AR button ready' });
}

async function enterAR(browser) {
  await browser.evaluate('window.__app.startAR()');
  await browser.waitFor('window.__app.snapshot().site.visible', { label: 'site visible' });
  return snapshot(browser);
}

async function pressTrigger(browser) {
  const tableBefore = (await snapshot(browser)).tableIndex;
  await browser.evaluate(`(async () => {
    const right = window.__iwer.xrDevice.controllers.right;
    right.updateButtonValue('trigger', 1);
    await new Promise((r) => setTimeout(r, 150));
    right.updateButtonValue('trigger', 0);
    await new Promise((r) => setTimeout(r, 150));
  })()`);
  await browser.waitFor(`window.__app.snapshot().tableIndex !== ${tableBefore}`, { timeout: 3000, label: 'table change after trigger' });
  return snapshot(browser);
}

/** Waits until the debug log (what the page sent to the dev server) has a console line matching `pattern`. */
async function waitForDebugLog(pattern, { timeout = 8000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const lines = fs.existsSync(debugLogFile) ? fs.readFileSync(debugLogFile, 'utf8').trim().split('\n') : [];
    const match = lines.map((l) => JSON.parse(l)).find((e) => e.kind === 'console' && pattern.test(e.message));
    if (match) return match.message;
    await sleep(200);
  }
  throw new Error(`debug log never showed ${pattern}`);
}

/** How many console lines matching `pattern` the debug log has so far. */
function countDebugLog(pattern) {
  if (!fs.existsSync(debugLogFile)) return 0;
  return fs
    .readFileSync(debugLogFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'console' && pattern.test(e.message)).length;
}

/** Turn the emulated right controller so its ray points at a menu button, and wait for the hover. */
async function aimAtMenuButton(browser, id) {
  await browser.waitFor(`window.__app.snapshot().menu.buttons.${id}`, { label: `menu button ${id}` });
  await browser.evaluate(`(() => {
    const target = window.__app.snapshot().menu.buttons.${id};
    const right = window.__iwer.xrDevice.controllers.right;
    const from = [right.position.x, right.position.y, right.position.z];
    let d = target.map((v, i) => v - from[i]);
    const length = Math.hypot(...d);
    d = d.map((v) => v / length);
    // Rotation that turns the controller's -Z (its pointing direction) onto d.
    const axis = [d[1], -d[0], 0]; // (0, 0, -1) x d
    const sin = Math.hypot(...axis);
    const angle = Math.atan2(sin, -d[2]);
    const k = sin < 1e-9 ? 0 : Math.sin(angle / 2) / sin;
    right.quaternion.set(axis[0] * k, axis[1] * k, axis[2] * k, Math.cos(angle / 2));
  })()`);
  await browser.waitFor(`window.__app.snapshot().menu.hovered === '${id}'`, { timeout: 3000, label: `hovering ${id}` });
}

async function clickTrigger(browser) {
  await browser.evaluate(`(async () => {
    const right = window.__iwer.xrDevice.controllers.right;
    right.updateButtonValue('trigger', 1);
    await new Promise((r) => setTimeout(r, 150));
    right.updateButtonValue('trigger', 0);
  })()`);
}

const scenarios = {
  async 'page without AR support explains itself'(browser, base) {
    await browser.goto(`${base}?emulate=0`);
    const text = await browser.waitFor(
      'document.getElementById("enter-ar").textContent === "AR unavailable" && document.getElementById("status").textContent',
      { label: 'unsupported message' },
    );
    if (!/support/i.test(text)) throw new Error(`unexpected status text: ${text}`);
    assertNoProblems(browser);
    return text;
  },

  async 'meeting room: dig site on the centre of the only table, facing the user'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    // Enter AR only enables after the shaders are compiled; entering AR must not compile any more.
    // Nor upload any more geometry: the warm-up draw already did.
    const precompiled = await waitForDebugLog(/^\[shaders\] precompiled \d+ shader programs, \d+ textures and \d+ meshes/);
    const before = await snapshot(browser);
    const s = await enterAR(browser);
    await sleep(500); // a few more frames with the site, panel and menu on screen
    const after = await snapshot(browser);
    if (!(before.programs > 0) || after.programs !== before.programs) {
      throw new Error(`shader programs: ${before.programs} before AR, ${after.programs} in AR; precompile missed some (${precompiled})`);
    }
    if (!(before.geometries > 50) || after.geometries !== before.geometries) {
      throw new Error(`GPU geometries: ${before.geometries} before AR, ${after.geometries} in AR; the warm-up draw missed some (${precompiled})`);
    }
    if (s.referenceSpaceType !== 'local-floor') throw new Error(`reference space ${s.referenceSpaceType}`);
    if (!s.enabledFeatures.includes('plane-detection')) throw new Error('plane-detection not enabled');
    if (s.state !== 'placed' || s.tableCount !== 1) throw new Error(`state ${s.state}, tables ${s.tableCount}`);
    assertNear(s.site.position, siteBaseFor(MEETING_ROOM_TABLE), 'site base');
    if (Math.abs(s.site.scale - 1) > 1e-6) throw new Error(`the site should be full size on this big table, got scale ${s.site.scale}`);
    assertOnMeetingTable(s.site, 'centred');
    // Its front (+Z, where the worker looks) faces the user, within 45 degrees.
    const viewer = await browser.evaluate('(() => { const p = window.__iwer.xrDevice.position; return [p.x, p.y, p.z]; })()');
    const facing = s.site.yaw + s.site.spin;
    const toViewer = [viewer[0] - s.site.position[0], viewer[2] - s.site.position[2]];
    const cos = (Math.sin(facing) * toViewer[0] + Math.cos(facing) * toViewer[1]) / Math.hypot(...toViewer);
    if (cos < Math.SQRT1_2 - 1e-6) throw new Error(`the site faces ${((Math.acos(cos) * 180) / Math.PI).toFixed(0)}° away from the user`);
    const shots = [await browser.screenshot('meeting_room-default-view')];

    // Walk up to the table and look down at the site.
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.07, 1.3, -0.55);
      const pitch = -38 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    await sleep(800);
    shots.push(await browser.screenshot('meeting_room-close-up'));

    // The startup trace covers the session's first 3 s and then logs one summary line.
    const startup = await waitForDebugLog(/^\[startup\] first frame \d+ ms after the session started; \d+ frames in 3 s, /, {
      timeout: 10000,
    });
    shots.push(startup.slice(0, 120));

    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting && document.getElementById("enter-ar").textContent === "Enter AR"', {
      label: 'session ended',
    });
    assertNoProblems(browser);
    return shots.join(', ');
  },

  async 'meeting room: right stick swings the cab, holding B repaints the excavator'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    const start = await enterAR(browser);
    const right = 'window.__iwer.xrDevice.controllers.right';
    const hold = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;
    const swingFor = (x, ms) =>
      browser.evaluate(`(async () => { ${right}.updateAxes('thumbstick', ${x}, 0); await ${hold(ms)}; ${right}.updateAxes('thumbstick', 0, 0); await ${hold(500)}; })()`);

    // Full right for 1 s: the cab swings clockwise (negative), ~50 degrees after the ramp-up,
    // and stops soon after the stick is let go. The chassis, and the site, stay as they are.
    await swingFor(1, 1000);
    const afterRight = await snapshot(browser);
    const swung = afterRight.excavator.swing - start.excavator.swing;
    if (!(swung < -0.5 && swung > -1.3)) throw new Error(`stick right swung the cab by ${swung.toFixed(3)} rad`);
    assertNear(afterRight.excavator.position, start.excavator.position, 'the chassis while swinging');
    if (afterRight.excavator.heading !== start.excavator.heading) throw new Error('swinging turned the chassis');
    if (afterRight.site.spin !== start.site.spin) throw new Error('the right stick spun the whole site');
    if (afterRight.site.color !== start.site.color) throw new Error('colour changed without B');
    await sleep(400);
    if ((await snapshot(browser)).excavator.swing !== afterRight.excavator.swing) throw new Error('the cab kept swinging after the stick was released');

    // Full left for 0.6 s swings it back the other way.
    await swingFor(-1, 600);
    const afterLeft = await snapshot(browser);
    if (!(afterLeft.excavator.swing > afterRight.excavator.swing + 0.2)) throw new Error(`stick left: swing ${afterRight.excavator.swing} -> ${afterLeft.excavator.swing}`);

    // A digs now and leaves the paint alone; holding B cycles the colour, and letting go keeps it.
    await browser.evaluate(`(async () => { ${right}.updateButtonValue('a-button', 1); await ${hold(600)}; ${right}.updateButtonValue('a-button', 0); await ${hold(100)}; })()`);
    const afterA = await snapshot(browser);
    if (afterA.site.color !== start.site.color) throw new Error('holding A still repaints the excavator');
    if (!(afterA.excavator.digTime > 0.3)) throw new Error(`holding A didn't dig (dig time ${afterA.excavator.digTime})`);
    await browser.evaluate(`(async () => { ${right}.updateButtonValue('b-button', 1); await ${hold(1000)}; ${right}.updateButtonValue('b-button', 0); await ${hold(100)}; })()`);
    const afterB = await snapshot(browser);
    if (afterB.site.color === start.site.color) throw new Error(`colour unchanged after holding B (${afterB.site.color})`);
    if (afterB.excavator.digTime !== afterA.excavator.digTime) throw new Error('B moved the arm');
    await sleep(400);
    if ((await snapshot(browser)).site.color !== afterB.site.color) throw new Error('colour kept changing after B was released');

    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.07, 1.3, -0.55);
      const pitch = -38 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    await sleep(800);
    const shot = await browser.screenshot('meeting_room-swung-and-recoloured');
    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    assertNoProblems(browser);
    return `swing 0 → ${afterRight.excavator.swing.toFixed(2)} → ${afterLeft.excavator.swing.toFixed(2)} rad, colour ${start.site.color} → ${afterB.site.color}; ${shot}`;
  },

  async 'meeting room: left stick drives the excavator along its heading; it stops at the rocks and the table edge'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    const start = await enterAR(browser);
    const left = 'window.__iwer.xrDevice.controllers.left';
    const push = (x, y, ms) =>
      browser.evaluate(`(async () => {
        ${left}.updateAxes('thumbstick', ${x}, ${y});
        await new Promise((r) => setTimeout(r, ${ms}));
        ${left}.updateAxes('thumbstick', 0, 0);
        await new Promise((r) => setTimeout(r, 500)); // it brakes to a stop
      })()`);
    // Where `b` is from `a`, along `a`'s forward direction and across it (metres).
    const moved = (a, b) => {
      const [dx, dz] = [b.position[0] - a.position[0], b.position[2] - a.position[2]];
      const [fx, fz] = a.forward;
      return { along: dx * fx + dz * fz, across: -dx * fz + dz * fx, up: b.position[1] - a.position[1] };
    };
    const e0 = start.excavator;
    if (!e0.atHome || e0.steering !== 'relative') throw new Error(`at the start: ${JSON.stringify(e0)}`);

    // Forward (stick y = -1) for 0.7 s: it drives ahead, towards the rocks, ramping up and
    // braking to a stop, along its own heading and never sideways. The rest of the site stays.
    await push(0, -1, 700);
    const ahead = await snapshot(browser);
    const f = moved(e0, ahead.excavator);
    if (!(f.along > 0.04 && f.along < 0.13) || Math.abs(f.across) > 0.002 || Math.abs(f.up) > 1e-6) {
      throw new Error(`a forward push moved it ${f.along.toFixed(3)} m ahead, ${f.across.toFixed(3)} m across, ${f.up} up`);
    }
    if (ahead.excavator.heading !== e0.heading) throw new Error('driving straight turned it');
    assertNear(ahead.site.position, start.site.position, 'the rest of the site');
    await sleep(300);
    if (moved(ahead.excavator, (await snapshot(browser)).excavator).along !== 0) throw new Error('it kept rolling after it stopped');

    // Right for 0.8 s turns it clockwise on the spot; left for 0.8 s turns it back.
    await push(1, 0, 800);
    const turned = await snapshot(browser);
    const turn = turned.excavator.heading - ahead.excavator.heading;
    if (!(turn < -0.4 && turn > -1.2)) throw new Error(`stick right turned it ${turn.toFixed(3)} rad`);
    const shift = Math.hypot(turned.excavator.position[0] - ahead.excavator.position[0], turned.excavator.position[2] - ahead.excavator.position[2]);
    if (shift > 1e-6) throw new Error(`turning on the spot moved it ${shift} m`);
    await push(-1, 0, 800);
    const straight = await snapshot(browser);
    if (Math.abs(straight.excavator.heading - ahead.excavator.heading) > 0.05) throw new Error(`turning back left it at ${straight.excavator.heading.toFixed(3)} rad`);

    // Forward for 3 s: it drives up to the rock pile and stops there, touching it.
    await push(0, -1, 3000);
    const atRocks = await snapshot(browser);
    if (Math.abs(atRocks.excavator.clearance) > 0.002) throw new Error(`stopped ${atRocks.excavator.clearance.toFixed(3)} m from the rocks`);
    const r = moved(straight.excavator, atRocks.excavator);
    if (!(r.along > 0.01) || Math.abs(r.across) > 1e-6) throw new Error(`towards the rocks: ${r.along.toFixed(3)} m ahead, ${r.across} m across`);

    // Backwards for 9 s: it reverses to the table's edge and stops with its body on the table.
    await push(0, 1, 9000);
    const atEdge = await snapshot(browser);
    const { onTable, limits, radius } = atEdge.excavator;
    if (Math.abs(onTable.x) > limits.x + 1e-6 || Math.abs(onTable.z) > limits.z + 1e-6) {
      throw new Error(`it left the table: at ${JSON.stringify(onTable)}, limits ${JSON.stringify(limits)}`);
    }
    const reach = Math.max(Math.abs(onTable.x) / limits.x, Math.abs(onTable.z) / limits.z);
    if (Math.abs(reach - 1) > 0.005) throw new Error(`expected it to stop at the edge, got ${reach.toFixed(3)} of the way`);
    if (moved(atRocks.excavator, atEdge.excavator).along > -0.2) throw new Error('it didn\'t reverse');
    // Check against the scanned table, not just the app's own numbers: its body circle touches an edge.
    const [ex, , ez] = atEdge.excavator.position;
    const [tx, , tz] = MEETING_ROOM_TABLE;
    const gap = Math.min(
      ex - (tx - MEETING_ROOM_TABLE_WIDTH / 2),
      tx + MEETING_ROOM_TABLE_WIDTH / 2 - ex,
      ez - (tz - MEETING_ROOM_TABLE_DEPTH / 2),
      tz + MEETING_ROOM_TABLE_DEPTH / 2 - ez,
    );
    if (Math.abs(gap - radius) > TOLERANCE) throw new Error(`its centre stopped ${gap.toFixed(3)} m from the table edge, expected its body radius ${radius.toFixed(3)} m`);
    assertOnMeetingTable(atEdge.site, 'at the edge'); // the arm points back over the table

    // Scene data can drop out for a moment (seen on the Quest). Hide the table, plane and
    // mesh, for 400 ms: the excavator must stay where the user drove it, and come back
    // without a new pick.
    await sleep(2500); // let any pending debug-log batch arrive before counting
    const PICK = /^\[tables\] (first|tables changed|table lost|user): /;
    const picksBefore = countDebugLog(PICK);
    await browser.evaluate(`(() => {
      const sem = window.__iwer.xrDevice.sem;
      const table = (e) => e.semanticLabel === 'table';
      window.__dropped = { planes: [...sem.trackedPlanes].filter(table), meshes: [...sem.trackedMeshes].filter(table) };
      for (const e of window.__dropped.planes) sem.trackedPlanes.delete(e);
      for (const e of window.__dropped.meshes) sem.trackedMeshes.delete(e);
    })()`);
    await browser.waitFor('window.__app.snapshot().tableCount === 0', { label: 'table gone' });
    await sleep(400);
    const during = await snapshot(browser);
    if (!during.site.visible) throw new Error('the site disappeared during a brief dropout');
    assertNear(during.excavator.position, atEdge.excavator.position, 'during the dropout');
    await browser.evaluate(`(() => {
      const sem = window.__iwer.xrDevice.sem;
      for (const e of window.__dropped.planes) sem.trackedPlanes.add(e);
      for (const e of window.__dropped.meshes) sem.trackedMeshes.add(e);
    })()`);
    await browser.waitFor('window.__app.snapshot().tableCount === 1', { label: 'table back' });
    await sleep(2500); // a debug-log flush happens every 2 s
    const afterDropout = await snapshot(browser);
    assertNear(afterDropout.excavator.position, atEdge.excavator.position, 'after the dropout');
    if (afterDropout.excavator.heading !== atEdge.excavator.heading) throw new Error('the dropout turned the excavator');
    if (afterDropout.site.spin !== atEdge.site.spin) throw new Error('the dropout turned the site');
    const picksAfter = countDebugLog(PICK);
    if (picksAfter !== picksBefore) throw new Error(`the dropout caused ${picksAfter - picksBefore} new table pick(s)`);
    // IWER hands the plane back as a new object, which the debug log should say.
    await waitForDebugLog(/^\[tables\] table back after \d+ ms as a new object in the same place; the site stayed put$/);

    // Absolute steering, from the menu: the stick says where to go, as the user sees it.
    await browser.evaluate(`(() => { const d = window.__iwer.xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); })()`);
    await sleep(300); // let the menu turn to face the new head position before aiming at it
    await aimAtMenuButton(browser, 'steering');
    await clickTrigger(browser);
    await browser.waitFor(`window.__app.snapshot().excavator.steering === 'absolute'`, { timeout: 3000, label: 'absolute steering' });
    if ((await snapshot(browser)).menu.labels.steering !== 'Steering: absolute') throw new Error('the menu label didn\'t change');
    await waitForDebugLog(/^\[drive\] steering: absolute$/);
    // The user faces -Z, so pulling the stick back means "towards me" (+Z). The excavator
    // faces -X: it turns a quarter to the left first, then drives towards the user.
    await push(0, 1, 5000);
    const towardsUser = await snapshot(browser);
    const [fx, fz] = towardsUser.excavator.forward;
    if (fz < 0.98) throw new Error(`absolute steering left it facing [${fx.toFixed(2)}, ${fz.toFixed(2)}], expected +Z`);
    const drove = towardsUser.excavator.position[2] - atEdge.excavator.position[2];
    if (!(drove > 0.15)) throw new Error(`absolute steering drove it ${drove.toFixed(3)} m towards the user`);
    // Back to relative, which the other scenarios expect (it's remembered in localStorage).
    await clickTrigger(browser);
    await browser.waitFor(`window.__app.snapshot().excavator.steering === 'relative'`, { timeout: 3000, label: 'relative steering again' });

    const [cx, , cz] = towardsUser.excavator.position;
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(${cx - 0.45}, 1.3, ${cz + 0.55});
      const pitch = -40 * Math.PI / 180, yaw = -40 * Math.PI / 180;
      // yaw about Y, then pitch about X (YXZ), so the view looks down at the excavator.
      const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      d.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    })()`);
    await sleep(800);
    const shot = await browser.screenshot('meeting_room-driven');
    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    assertNoProblems(browser);
    return `ahead ${f.along.toFixed(3)} m, turned ${turn.toFixed(2)} rad, stopped at the rocks and ${gap.toFixed(3)} m from the edge; absolute drove ${drove.toFixed(2)} m; ${shot}`;
  },

  async 'meeting room: holding A digs and letting go stops the arm; sound, and the menu mutes it'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    await enterAR(browser);
    // Look down at the dig site from close by, so the screenshots show the arm.
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.069, 1.25, -0.95);
      const pitch = -40 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    const right = 'window.__iwer.xrDevice.controllers.right';

    // The arm rests until A is held.
    await sleep(500);
    let s = await snapshot(browser);
    if (s.excavator.digTime !== 0 || s.excavator.digging) throw new Error(`the arm moved without A: ${JSON.stringify(s.excavator)}`);

    // Held for a whole cycle (6 s): every phase shows up, and nothing solid goes below the table top.
    const tableTop = MEETING_ROOM_TABLE[1];
    const seen = [];
    const shots = [];
    await browser.evaluate(`${right}.updateButtonValue('a-button', 1)`);
    const end = Date.now() + 6500;
    while (Date.now() < end) {
      s = await snapshot(browser);
      const phase = s.site.digPhase;
      if (phase && seen[seen.length - 1] !== phase) {
        seen.push(phase);
        if (phase === 'lift' || phase === 'return') shots.push(await browser.screenshot(`dig-${phase === 'lift' ? 'scooped' : 'dumped'}`));
      }
      if (s.site.bounds.min[1] < tableTop - 0.005) throw new Error(`a solid part went ${((tableTop - s.site.bounds.min[1]) * 1000).toFixed(1)} mm below the table during ${phase}`);
      await sleep(100);
    }
    for (const phase of ['reach', 'scoop', 'lift', 'dump', 'return']) {
      if (!seen.includes(phase)) throw new Error(`dig phase ${phase} never showed up (saw ${seen.join(' → ')})`);
    }

    // Let go part-way into the next cycle: the arm stops where it is.
    await sleep(1200);
    await browser.evaluate(`${right}.updateButtonValue('a-button', 0)`);
    await sleep(200);
    const released = await snapshot(browser);
    await sleep(600);
    const later = await snapshot(browser);
    if (later.excavator.digTime !== released.excavator.digTime || later.site.digPhase !== released.site.digPhase) {
      throw new Error(`the arm kept moving after A was released: ${released.excavator.digTime} -> ${later.excavator.digTime}`);
    }
    if (!(released.excavator.digTime > 6.5)) throw new Error(`dig time ${released.excavator.digTime} after ~7.7 s of holding A`);

    // The audio runs (headless Chrome is started with autoplay allowed) but is off by default;
    // the menu's Sound button turns it on and off again.
    s = await snapshot(browser);
    if (s.sound.state !== 'running') throw new Error(`audio state ${s.sound.state}`);
    if (!s.sound.muted || s.menu.labels.sound !== 'Sound off') throw new Error(`sound should start off: ${JSON.stringify(s.sound)}, label ${s.menu.labels.sound}`);
    await browser.evaluate(`(() => { const d = window.__iwer.xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); })()`);
    await sleep(300); // let the menu turn to face the new head position before aiming at it
    await aimAtMenuButton(browser, 'sound');
    await clickTrigger(browser);
    await browser.waitFor('window.__app.snapshot().sound.muted === false', { timeout: 3000, label: 'turned on by the menu' });
    s = await snapshot(browser);
    if (s.menu.labels.sound !== 'Sound on') throw new Error(`label after turning on: ${s.menu.labels.sound}`);
    await waitForDebugLog(/^\[sound\] on$/);
    await clickTrigger(browser);
    await browser.waitFor('window.__app.snapshot().sound.muted === true', { timeout: 3000, label: 'turned off by the menu' });
    await waitForDebugLog(/^\[sound\] off$/);

    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    await browser.waitFor(`window.__app.snapshot().sound.state === 'suspended'`, { timeout: 3000, label: 'audio suspended after AR' });
    assertNoProblems(browser);
    return `${seen.join(' → ')}; ${shots.join(', ')}`;
  },

  async 'meeting room: depth sensing hides the dig site behind real things'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    await enterAR(browser);
    await browser.waitFor('window.__app.snapshot().depth?.active === true', { timeout: 5000, label: 'depth sensing active' });
    const s = await snapshot(browser);
    if (s.depth.usage !== 'gpu-optimized') throw new Error(`depth usage ${s.depth.usage}`);
    if (!s.enabledFeatures.includes('depth-sensing')) throw new Error('depth-sensing not enabled');
    await waitForDebugLog(/^\[depth\] depth sensing on: gpu-optimized/);
    await waitForDebugLog(/^\[depth\] first depth frame \d+ ms into the session: occlusion active$/);

    // Eyes 1.5 cm below the table top, 1.3 m from the site. IWER's depth includes the table's
    // bounding box, whose near edge (25 cm ahead) should hide the bottom ~6 cm of the site
    // and fade the rest in above it. (At z -0.2 a chair in the room scan is 4 cm from the eyes.)
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.069, ${MEETING_ROOM_TABLE[1] - 0.015}, -0.25);
      const pitch = 3 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    await sleep(800);
    const low = await shownFraction(browser);
    if (low < 0.2 || low > 0.85) throw new Error(`behind the table edge ${pct(low)} of the dig site shows; expected only its top part`);
    const shots = [await browser.screenshot('occlusion-low-view')];

    // From above nothing real is in front of the site, and the table under it is within the
    // tolerance: nothing may be hidden, the rubble and its bottom edge included.
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.069, 1.25, -0.95);
      const pitch = -40 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    await sleep(800);
    const above = await shownFraction(browser);
    if (above < 0.97) throw new Error(`seen from above only ${pct(above)} of the dig site shows`);
    shots.push(await browser.screenshot('occlusion-above-view'));

    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    assertNoProblems(browser);
    return `${pct(low)} shown from low, ${pct(above)} from above; ${shots.join(', ')}`;
  },

  async 'menu on the left controller: version line, Exit AR and Reload page'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=living_room');
    const version = await browser.waitFor('document.getElementById("version").textContent', { label: 'version line' });
    if (!/^Updated /.test(version)) throw new Error(`version line: ${version}`);

    let s = await enterAR(browser);
    await browser.waitFor('window.__app.snapshot().menu.visible', { label: 'menu visible' });
    s = await snapshot(browser);
    if (s.menu.holder !== 'left controller') throw new Error(`menu holder: ${s.menu.holder}`);
    const table = s.tableIndex;

    // Exit AR: pointing at the button and pulling the trigger ends the session, and the
    // trigger pull must not also move the dig site to another table.
    await aimAtMenuButton(browser, 'exit');
    const shot = await browser.screenshot('menu-hovering-exit');
    await clickTrigger(browser);
    await browser.waitFor('!window.__app.snapshot().presenting', { timeout: 3000, label: 'session ended by Exit AR' });
    s = await snapshot(browser);
    if (s.tableIndex !== -1 && s.tableIndex !== table) throw new Error('the Exit AR press also switched tables');
    const status = await browser.evaluate('document.getElementById("status").textContent');
    if (!/Session ended/.test(status)) throw new Error(`status after Exit AR: ${status}`);
    await waitForDebugLog(/^\[menu\] exit pressed$/);

    // Reload page: the page reloads (the marker disappears) and comes back ready.
    await enterAR(browser);
    await browser.waitFor('window.__app.snapshot().menu.visible', { label: 'menu visible again' });
    await browser.evaluate('window.__reloadMarker = 1');
    await aimAtMenuButton(browser, 'reload');
    await clickTrigger(browser).catch(() => {}); // the page may unload mid-call
    await browser.waitFor('window.__reloadMarker === undefined && window.__app && !window.__app.snapshot().presenting', {
      timeout: 15000,
      label: 'page reloaded',
    });
    await waitForDebugLog(/^\[menu\] reload pressed$/); // sent as the page unloaded
    assertNoProblems(browser);
    return `${version}; ${shot}`;
  },

  async 'living room: tables that arrive late still get the dig site'(browser, base) {
    // On the Quest the room's tables arrive over the first frames, sometimes the far ones
    // first. Hide every table but the farthest (2.7 m) before entering AR, then add the
    // same scene entities back: the first pick is provisional, so the site must move to
    // the nearest table instead of staying where it landed.
    await openApp(browser, base, 'emulate=1&env=living_room');
    const hidden = await browser.evaluate(`(() => {
      const sem = window.__iwer.xrDevice.sem;
      const late = (e) => e.semanticLabel === 'table' && Math.hypot(e.transform.matrix[12], e.transform.matrix[14]) < 2.5;
      window.__late = { planes: [...sem.trackedPlanes].filter(late), meshes: [...sem.trackedMeshes].filter(late) };
      for (const e of window.__late.planes) sem.trackedPlanes.delete(e);
      for (const e of window.__late.meshes) sem.trackedMeshes.delete(e);
      return window.__late.planes.length;
    })()`);
    if (hidden !== 3) throw new Error(`expected to hold back 3 tables, held back ${hidden}`);

    let s = await enterAR(browser);
    if (s.tableCount !== 1) throw new Error(`expected 1 table at first, got ${s.tableCount}`);
    assertNear(s.site.position, siteBaseFor(LIVING_ROOM_TABLES[2]), 'first pick: the only (far) table');
    if (s.pick.reason !== 'first' || !s.pick.provisional) throw new Error(`first pick: ${JSON.stringify(s.pick)}`);
    await waitForDebugLog(/^\[tables\] first: table 1 of 1, 2\.7 m away$/);

    await browser.evaluate(`(() => {
      const sem = window.__iwer.xrDevice.sem;
      for (const e of window.__late.planes) sem.trackedPlanes.add(e);
      for (const e of window.__late.meshes) sem.trackedMeshes.add(e);
    })()`);
    await browser.waitFor('window.__app.snapshot().tableCount === 4', { label: 'late tables arrived' });
    s = await snapshot(browser);
    assertNear(s.site.position, siteBaseFor(LIVING_ROOM_TABLES[0]), 'after the late tables: the nearest one');
    if (s.pick.reason !== 'tables changed') throw new Error(`pick after late tables: ${JSON.stringify(s.pick)}`);
    const line = await waitForDebugLog(/^\[tables\] tables changed: /);
    if (!/table 1 of 4, 1\.3 m away$/.test(line)) throw new Error(`debug log: ${line}`);
    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    assertNoProblems(browser);
    return line;
  },

  async 'living room: nearest of four tables, trigger cycles through all'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=living_room');
    let s = await enterAR(browser);
    if (s.tableCount !== 4) throw new Error(`expected 4 tables, got ${s.tableCount}`);
    if (s.tableIndex !== 0) throw new Error(`expected the nearest table, got index ${s.tableIndex}`);
    assertNear(s.site.position, siteBaseFor(LIVING_ROOM_TABLES[0]), 'nearest table');
    if (!s.panel?.startsWith('Table 1 of 4')) throw new Error(`hint panel: ${s.panel}`);
    // That table is ~70 degrees to the right of the starting gaze, so the panel points the way.
    if (!s.panel.includes('Turn right')) throw new Error(`expected a direction hint, got: ${s.panel}`);
    const shot = await browser.screenshot('living_room-nearest-table');

    const visited = [s.site.position];
    // Drive the excavator off home with the left stick: the next table must still get it back home.
    // This table is turned about 90 degrees, so a yaw-sign or frame mix-up shows here: the
    // excavator must move along the forward direction it reports, in the room.
    await browser.evaluate(`(async () => {
      const left = window.__iwer.xrDevice.controllers.left;
      left.updateAxes('thumbstick', 0, -1);
      await new Promise((r) => setTimeout(r, 500));
      left.updateAxes('thumbstick', 0, 0);
      await new Promise((r) => setTimeout(r, 500));
    })()`);
    const driven = (await snapshot(browser)).excavator;
    const [ddx, , ddz] = driven.position.map((v, i) => v - s.excavator.position[i]);
    const [fx, fz] = s.excavator.forward;
    const along = ddx * fx + ddz * fz;
    const across = -ddx * fz + ddz * fx;
    if (!(along > 0.02) || Math.abs(across) > 0.002) {
      throw new Error(`stick forward moved the excavator ${along.toFixed(3)} m along and ${across.toFixed(3)} m across its forward [${fx.toFixed(2)}, ${fz.toFixed(2)}]`);
    }
    if (driven.atHome) throw new Error('the excavator still counts as at home after driving');
    for (let i = 1; i <= 4; i++) {
      s = await pressTrigger(browser);
      if (s.tableIndex !== i % 4) throw new Error(`press ${i}: expected index ${i % 4}, got ${s.tableIndex}`);
      if (s.panel?.startsWith(`Table ${(i % 4) + 1} of 4`) !== true) throw new Error(`press ${i}: hint panel ${s.panel}`);
      if (!s.excavator.atHome) throw new Error(`press ${i}: the excavator wasn't back home on the new table`);
      visited.push(s.site.position);
    }
    // Every table visited exactly once, then back to the first.
    for (const table of LIVING_ROOM_TABLES) {
      if (!visited.slice(0, 4).some((p) => Math.hypot(...p.map((v, k) => v - siteBaseFor(table)[k])) < TOLERANCE)) {
        throw new Error(`table at [${table.join(', ')}] never got the site`);
      }
    }
    assertNear(visited[4], visited[0], 'wrap-around');
    assertNoProblems(browser);
    return shot;
  },

  async 'other rooms: dig site stands on a table top'(browser, base) {
    const results = [];
    for (const env of ['office_small', 'office_large', 'music_room']) {
      await openApp(browser, base, `emulate=1&env=${env}`);
      const s = await enterAR(browser);
      if (s.state !== 'placed' || s.tableCount < 1) throw new Error(`${env}: state ${s.state}, tables ${s.tableCount}`);
      const y = s.site.position[1];
      if (y < 0.3 || y > 2.1) throw new Error(`${env}: site height ${y}`);
      await browser.evaluate('window.__app.endAR()');
      await browser.waitFor('!window.__app.snapshot().presenting', { label: `${env} session ended` });
      assertNoProblems(browser);
      if (!(s.site.scale > 0.5 && s.site.scale <= 1)) throw new Error(`${env}: site scale ${s.site.scale}`);
      results.push(`${env}: ${s.tableCount} table(s), site y=${y.toFixed(3)} scale=${s.site.scale.toFixed(2)}`);
    }
    return results.join('; ');
  },
};

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(debugLogFile, { force: true }); // the server starts it afresh
const server = await createServer({
  root,
  mode: 'e2e', // vite.config.js: no plain-HTTP mirror; the debug log goes to e2e-output/debug-log.jsonl
  logLevel: 'warn',
  server: { port: 5199, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const base = server.resolvedUrls.local[0];

let browser;
let failed = 0;
try {
  browser = await launchBrowser();
  // E2E_ONLY=<text> runs just the scenarios whose name contains <text>.
  const only = process.env.E2E_ONLY?.toLowerCase();
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !name.toLowerCase().includes(only)) continue;
    try {
      const detail = await run(browser, base);
      console.log(`✔ ${name}${detail ? `  (${detail})` : ''}`);
    } catch (err) {
      failed++;
      console.log(`✘ ${name}\n  ${err.message}`);
      await browser.screenshot(`FAILED-${name.replace(/[^a-z0-9]+/gi, '_')}`).catch(() => {});
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nAll scenarios passed');
process.exit(failed ? 1 : 0);
