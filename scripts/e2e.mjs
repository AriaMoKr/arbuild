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

  async 'meeting room: right stick spins the dig site, holding A repaints the excavator'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    const start = await enterAR(browser);
    const right = 'window.__iwer.xrDevice.controllers.right';
    const hold = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;

    // Full right for 1 s: clockwise (negative), roughly 45 degrees at the slow max speed.
    await browser.evaluate(`(async () => { ${right}.updateAxes('thumbstick', 1, 0); await ${hold(1000)}; ${right}.updateAxes('thumbstick', 0, 0); await ${hold(100)}; })()`);
    const afterRight = await snapshot(browser);
    const turned = afterRight.site.spin - start.site.spin;
    if (!(turned < -0.4 && turned > -1.6)) throw new Error(`stick right turned ${turned.toFixed(3)} rad`);
    if (afterRight.site.color !== start.site.color) throw new Error('colour changed without A');
    await sleep(400);
    if ((await snapshot(browser)).site.spin !== afterRight.site.spin) throw new Error('site kept spinning after the stick was released');

    // Full left for 0.5 s spins back the other way.
    await browser.evaluate(`(async () => { ${right}.updateAxes('thumbstick', -1, 0); await ${hold(500)}; ${right}.updateAxes('thumbstick', 0, 0); await ${hold(100)}; })()`);
    const afterLeft = await snapshot(browser);
    if (!(afterLeft.site.spin > afterRight.site.spin + 0.2)) throw new Error(`stick left: spin ${afterRight.site.spin} -> ${afterLeft.site.spin}`);

    // Holding A cycles the colour; releasing keeps the colour it reached.
    await browser.evaluate(`(async () => { ${right}.updateButtonValue('a-button', 1); await ${hold(1000)}; ${right}.updateButtonValue('a-button', 0); await ${hold(100)}; })()`);
    const afterA = await snapshot(browser);
    if (afterA.site.color === start.site.color) throw new Error(`colour unchanged after holding A (${afterA.site.color})`);
    if (afterA.site.spin !== afterLeft.site.spin) throw new Error('A button spun the site');
    await sleep(400);
    if ((await snapshot(browser)).site.color !== afterA.site.color) throw new Error('colour kept changing after A was released');

    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.07, 1.3, -0.55);
      const pitch = -38 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    await sleep(800);
    const shot = await browser.screenshot('meeting_room-spun-and-recoloured');
    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    assertNoProblems(browser);
    return `spin ${start.site.spin.toFixed(2)} → ${afterRight.site.spin.toFixed(2)} → ${afterLeft.site.spin.toFixed(2)} rad, colour ${start.site.color} → ${afterA.site.color}; ${shot}`;
  },

  async 'meeting room: left stick slides the dig site across the table and stops at its edge'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    const start = await enterAR(browser);
    const left = 'window.__iwer.xrDevice.controllers.left';
    const push = (x, y, ms) =>
      browser.evaluate(`(async () => {
        ${left}.updateAxes('thumbstick', ${x}, ${y});
        await new Promise((r) => setTimeout(r, ${ms}));
        ${left}.updateAxes('thumbstick', 0, 0);
        await new Promise((r) => setTimeout(r, 100));
      })()`);
    const delta = (a, b) => b.site.position.map((v, i) => v - a.site.position[i]);

    // The emulated user faces -Z, so forward (stick y = -1) moves the site towards -Z at 0.25 m/s.
    await push(0, -1, 1000);
    const afterForward = await snapshot(browser);
    const [fx, fy, fz] = delta(start, afterForward);
    if (!(fz < -0.15 && fz > -0.4) || Math.abs(fx) > 0.02 || Math.abs(fy) > 1e-6) {
      throw new Error(`forward push moved the site by [${fx.toFixed(3)}, ${fy.toFixed(3)}, ${fz.toFixed(3)}]`);
    }

    // Right moves it towards +X.
    await push(1, 0, 600);
    const afterRight = await snapshot(browser);
    const [rx, , rz] = delta(afterForward, afterRight);
    if (!(rx > 0.08 && rx < 0.3) || Math.abs(rz) > 0.02) throw new Error(`right push moved the site by [${rx.toFixed(3)}, ${rz.toFixed(3)}]`);
    await sleep(300);
    if (delta(afterRight, await snapshot(browser)).some((v) => Math.abs(v) > 1e-6)) throw new Error('site drifted after the stick was released');

    // Holding left long enough to cross the whole table stops at the table's edge.
    await push(-1, 0, 5000);
    const atEdge = await snapshot(browser);
    const { offset, limits } = atEdge.site;
    if (Math.abs(offset.x) > limits.x + 1e-9 || Math.abs(offset.z) > limits.z + 1e-9) {
      throw new Error(`site left the table: offset ${JSON.stringify(offset)}, limits ${JSON.stringify(limits)}`);
    }
    const reach = Math.max(Math.abs(offset.x) / limits.x, Math.abs(offset.z) / limits.z);
    if (Math.abs(reach - 1) > 1e-6) throw new Error(`expected the site to stop at the edge, got ${reach.toFixed(3)} of the way`);
    if (Math.abs(atEdge.site.position[1] - start.site.position[1]) > 1e-6) throw new Error('site height changed while sliding');

    // Check the edge against the scanned table, not just the app's own limits: the site's
    // footprint circle (shadows included) touches the edge, and every solid part is on the table.
    const tableLeft = MEETING_ROOM_TABLE[0] - MEETING_ROOM_TABLE_WIDTH / 2;
    if (Math.abs(atEdge.site.position[0] - (tableLeft + atEdge.site.radius)) > TOLERANCE) {
      throw new Error(`site stopped at x=${atEdge.site.position[0].toFixed(3)}, expected ${(tableLeft + atEdge.site.radius).toFixed(3)} (table edge + footprint radius)`);
    }
    assertOnMeetingTable(atEdge.site, 'at the edge');

    // The footprint circle doesn't change with spin, so spinning at the edge keeps every part on the table.
    await browser.evaluate(`(async () => {
      const right = window.__iwer.xrDevice.controllers.right;
      right.updateAxes('thumbstick', 1, 0);
      await new Promise((r) => setTimeout(r, 1000));
      right.updateAxes('thumbstick', 0, 0);
      await new Promise((r) => setTimeout(r, 100));
    })()`);
    await push(-1, 0, 500);
    const spunAtEdge = await snapshot(browser);
    const spun = spunAtEdge.site.spin - atEdge.site.spin;
    if (Math.abs(spun) < 0.4) throw new Error(`right stick barely spun the site (${spun.toFixed(3)} rad)`);
    assertNear(spunAtEdge.site.position, atEdge.site.position, 'spun at the edge');
    assertOnMeetingTable(spunAtEdge.site, 'spun at the edge');

    const [cx, , cz] = atEdge.site.position;
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(${cx + 0.45}, 1.35, ${cz + 0.65});
      const pitch = -38 * Math.PI / 180, yaw = 35 * Math.PI / 180;
      // yaw about Y, then pitch about X (YXZ), so the view looks down at the site.
      const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      d.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    })()`);
    await sleep(800);
    const shot = await browser.screenshot('meeting_room-slid-to-edge');
    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting', { label: 'session ended' });
    assertNoProblems(browser);
    return `forward Δz=${fz.toFixed(3)}, right Δx=${rx.toFixed(3)}, stopped at offset (${offset.x.toFixed(3)}, ${offset.z.toFixed(3)}); ${shot}`;
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
    // Nudge the site off-centre with the left stick: the next table must still get it at its centre.
    // Keep it short: the site nearly fills this table's depth, so a long push would reach an edge of its narrow side.
    await browser.evaluate(`(async () => {
      const left = window.__iwer.xrDevice.controllers.left;
      left.updateAxes('thumbstick', 1, -1);
      await new Promise((r) => setTimeout(r, 300));
      left.updateAxes('thumbstick', 0, 0);
      await new Promise((r) => setTimeout(r, 100));
    })()`);
    const nudgedSnap = await snapshot(browser);
    const nudged = nudgedSnap.site.offset;
    if (Math.hypot(nudged.x, nudged.z) < 0.04) throw new Error(`left stick didn't move the site: ${JSON.stringify(nudged)}`);
    // This table is turned about 90 degrees, so a yaw-sign or table-frame mix-up shows here.
    // The user faces -Z: forward-right on the stick must move the site equally towards +X and -Z in the room.
    const [ndx, , ndz] = nudgedSnap.site.position.map((v, i) => v - s.site.position[i]);
    if (!(ndx > 0.03 && ndz < -0.03 && Math.abs(ndx + ndz) < 0.01)) {
      throw new Error(`stick forward-right moved the site by [${ndx.toFixed(3)}, ${ndz.toFixed(3)}] in the room; expected equal +x and -z`);
    }
    if (Math.abs(Math.hypot(ndx, ndz) - Math.hypot(nudged.x, nudged.z)) > 1e-4) throw new Error('room displacement does not match the table-frame offset');
    for (let i = 1; i <= 4; i++) {
      s = await pressTrigger(browser);
      if (s.tableIndex !== i % 4) throw new Error(`press ${i}: expected index ${i % 4}, got ${s.tableIndex}`);
      if (s.panel?.startsWith(`Table ${(i % 4) + 1} of 4`) !== true) throw new Error(`press ${i}: hint panel ${s.panel}`);
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
  for (const [name, run] of Object.entries(scenarios)) {
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
