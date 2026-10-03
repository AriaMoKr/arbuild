// End-to-end check without a headset: runs the Vite dev server, drives headless
// Chrome over the DevTools protocol, emulates a Quest 3 in Meta's synthetic rooms
// (IWER + SEM) and checks where the cube lands. Screenshots go to e2e-output/.
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
const CUBE_EDGE = 0.1;
const SURFACE_GAP = 0.001;
const TOLERANCE = 0.01; // metres

// Table-top centres in local-floor coordinates, read from @iwer/sem's captures.
const MEETING_ROOM_TABLE = [0.069, 0.73, -1.572];
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'table-cube-e2e-'));
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

function cubeCentreFor(tableTop) {
  return [tableTop[0], tableTop[1] + SURFACE_GAP + CUBE_EDGE / 2, tableTop[2]];
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
  await browser.waitFor('window.__app.snapshot().cube.visible', { label: 'cube visible' });
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

  async 'meeting room: cube on the centre of the only table'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    const s = await enterAR(browser);
    if (s.referenceSpaceType !== 'local-floor') throw new Error(`reference space ${s.referenceSpaceType}`);
    if (!s.enabledFeatures.includes('plane-detection')) throw new Error('plane-detection not enabled');
    if (s.state !== 'placed' || s.tableCount !== 1) throw new Error(`state ${s.state}, tables ${s.tableCount}`);
    assertNear(s.cube.position, cubeCentreFor(MEETING_ROOM_TABLE), 'cube centre');
    if (Math.abs(s.cube.edge - CUBE_EDGE) > 1e-6) throw new Error(`cube edge ${s.cube.edge}`);
    const shots = [await browser.screenshot('meeting_room-default-view')];

    // Walk up to the table and look down at the cube.
    await browser.evaluate(`(() => {
      const d = window.__iwer.xrDevice;
      d.position.set(0.07, 1.3, -0.55);
      const pitch = -38 * Math.PI / 180;
      d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    })()`);
    await sleep(800);
    shots.push(await browser.screenshot('meeting_room-close-up'));

    await browser.evaluate('window.__app.endAR()');
    await browser.waitFor('!window.__app.snapshot().presenting && document.getElementById("enter-ar").textContent === "Enter AR"', {
      label: 'session ended',
    });
    assertNoProblems(browser);
    return shots.join(', ');
  },

  async 'meeting room: right stick spins the cube, holding A changes its colour'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=meeting_room');
    const start = await enterAR(browser);
    const right = 'window.__iwer.xrDevice.controllers.right';
    const hold = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;

    // Full right for 1 s: clockwise (negative), roughly 45 degrees at the slow max speed.
    await browser.evaluate(`(async () => { ${right}.updateAxes('thumbstick', 1, 0); await ${hold(1000)}; ${right}.updateAxes('thumbstick', 0, 0); await ${hold(100)}; })()`);
    const afterRight = await snapshot(browser);
    const turned = afterRight.cube.spin - start.cube.spin;
    if (!(turned < -0.4 && turned > -1.6)) throw new Error(`stick right turned ${turned.toFixed(3)} rad`);
    if (afterRight.cube.color !== start.cube.color) throw new Error('colour changed without A');
    await sleep(400);
    if ((await snapshot(browser)).cube.spin !== afterRight.cube.spin) throw new Error('cube kept spinning after the stick was released');

    // Full left for 0.5 s spins back the other way.
    await browser.evaluate(`(async () => { ${right}.updateAxes('thumbstick', -1, 0); await ${hold(500)}; ${right}.updateAxes('thumbstick', 0, 0); await ${hold(100)}; })()`);
    const afterLeft = await snapshot(browser);
    if (!(afterLeft.cube.spin > afterRight.cube.spin + 0.2)) throw new Error(`stick left: spin ${afterRight.cube.spin} -> ${afterLeft.cube.spin}`);

    // Holding A cycles the colour; releasing keeps the colour it reached.
    await browser.evaluate(`(async () => { ${right}.updateButtonValue('a-button', 1); await ${hold(1000)}; ${right}.updateButtonValue('a-button', 0); await ${hold(100)}; })()`);
    const afterA = await snapshot(browser);
    if (afterA.cube.color === start.cube.color) throw new Error(`colour unchanged after holding A (${afterA.cube.color})`);
    if (afterA.cube.spin !== afterLeft.cube.spin) throw new Error('A button spun the cube');
    await sleep(400);
    if ((await snapshot(browser)).cube.color !== afterA.cube.color) throw new Error('colour kept changing after A was released');

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
    return `spin ${start.cube.spin.toFixed(2)} → ${afterRight.cube.spin.toFixed(2)} → ${afterLeft.cube.spin.toFixed(2)} rad, colour ${start.cube.color} → ${afterA.cube.color}; ${shot}`;
  },

  async 'living room: nearest of four tables, trigger cycles through all'(browser, base) {
    await openApp(browser, base, 'emulate=1&env=living_room');
    let s = await enterAR(browser);
    if (s.tableCount !== 4) throw new Error(`expected 4 tables, got ${s.tableCount}`);
    if (s.tableIndex !== 0) throw new Error(`expected the nearest table, got index ${s.tableIndex}`);
    assertNear(s.cube.position, cubeCentreFor(LIVING_ROOM_TABLES[0]), 'nearest table');
    if (!s.panel?.startsWith('Table 1 of 4')) throw new Error(`hint panel: ${s.panel}`);
    // That table is ~70 degrees to the right of the starting gaze, so the panel points the way.
    if (!s.panel.includes('Turn right')) throw new Error(`expected a direction hint, got: ${s.panel}`);
    const shot = await browser.screenshot('living_room-nearest-table');

    const visited = [s.cube.position];
    for (let i = 1; i <= 4; i++) {
      s = await pressTrigger(browser);
      if (s.tableIndex !== i % 4) throw new Error(`press ${i}: expected index ${i % 4}, got ${s.tableIndex}`);
      if (s.panel?.startsWith(`Table ${(i % 4) + 1} of 4`) !== true) throw new Error(`press ${i}: hint panel ${s.panel}`);
      visited.push(s.cube.position);
    }
    // Every table visited exactly once, then back to the first.
    for (const table of LIVING_ROOM_TABLES) {
      if (!visited.slice(0, 4).some((p) => Math.hypot(...p.map((v, k) => v - cubeCentreFor(table)[k])) < TOLERANCE)) {
        throw new Error(`table at [${table.join(', ')}] never got the cube`);
      }
    }
    assertNear(visited[4], visited[0], 'wrap-around');
    assertNoProblems(browser);
    return shot;
  },

  async 'other rooms: cube rests on a table top'(browser, base) {
    const results = [];
    for (const env of ['office_small', 'office_large', 'music_room']) {
      await openApp(browser, base, `emulate=1&env=${env}`);
      const s = await enterAR(browser);
      if (s.state !== 'placed' || s.tableCount < 1) throw new Error(`${env}: state ${s.state}, tables ${s.tableCount}`);
      const y = s.cube.position[1];
      if (y < 0.3 || y > 2.1) throw new Error(`${env}: cube height ${y}`);
      await browser.evaluate('window.__app.endAR()');
      await browser.waitFor('!window.__app.snapshot().presenting', { label: `${env} session ended` });
      assertNoProblems(browser);
      results.push(`${env}: ${s.tableCount} table(s), cube y=${y.toFixed(3)}`);
    }
    return results.join('; ');
  },
};

fs.mkdirSync(outDir, { recursive: true });
const server = await createServer({
  root,
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
