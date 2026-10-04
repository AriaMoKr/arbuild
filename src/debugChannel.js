// Dev-only debug channel: sends console output, uncaught errors and app state snapshots
// back to the dev server, which appends them to logs/quest-debug.jsonl (see
// scripts/vite-plugins.mjs). It lets you see what happens on the headset without USB
// debugging. main.js only loads it in dev builds; add ?debug=0 to turn it off.

const ENDPOINT = '/__debug';
const FLUSH_MS = 2000;
const SAMPLE_MS = 1000;
const FULL_STATE_MS = 10000; // a full snapshot at least this often, even when nothing changed
const MAX_QUEUE = 500;
const MAX_TEXT = 4000;

/** Starts capturing straight away; call watch(snapshot) once the app exists. */
export function startDebugChannel() {
  const queue = [];
  let sending = false;
  let lastKey = null;
  let lastStateAt = 0;
  let snapshot = null;

  const push = (kind, data) => {
    queue.push({ kind, at: Date.now(), ...data });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  };

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      push('console', { level, message: args.map(describe).join(' ') });
    };
  }
  window.addEventListener('error', (e) =>
    push('error', { message: e.message, source: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack }),
  );
  window.addEventListener('unhandledrejection', (e) =>
    push('error', { message: `Unhandled rejection: ${describe(e.reason)}`, stack: e.reason?.stack }),
  );

  const payload = (entries) =>
    JSON.stringify({ ua: navigator.userAgent, emulated: Boolean(window.__iwer), page: location.href, entries });

  async function flush() {
    if (sending || queue.length === 0) return;
    sending = true;
    const entries = queue.splice(0);
    const body = payload(entries);
    try {
      // keepalive lets the last batch out when the page unloads, but it caps the body at 64 kB.
      await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60000 });
    } catch {
      // Dev server unreachable: drop the batch rather than retry forever. Never log here,
      // or the failure would feed itself back into the queue.
    } finally {
      sending = false;
    }
  }

  function sample() {
    if (!snapshot) return;
    let state;
    try {
      state = snapshot();
    } catch (err) {
      push('error', { message: `snapshot failed: ${describe(err)}`, stack: err?.stack });
      return;
    }
    // Send right away when something the user would notice changes, and every
    // FULL_STATE_MS during an AR session (frame rate, positions).
    const key = JSON.stringify([state.presenting, state.state, state.tableCount, state.tableIndex, state.panel]);
    const now = Date.now();
    if (key !== lastKey || (state.presenting && now - lastStateAt >= FULL_STATE_MS)) {
      lastKey = key;
      lastStateAt = now;
      push('state', { state });
    }
  }

  push('page', {
    url: location.href,
    secure: window.isSecureContext,
    xr: 'xr' in navigator,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
  });
  setInterval(sample, SAMPLE_MS);
  setInterval(flush, FLUSH_MS);
  // Leaving or reloading the page: send whatever is queued with sendBeacon, which the
  // browser delivers even after the page is gone (a flush already in flight is no reason
  // to drop the rest, e.g. the "[menu] reload pressed" line).
  window.addEventListener('pagehide', () => {
    sample();
    if (queue.length === 0) return;
    const body = payload(queue.splice(0));
    if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
      fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  });
  flush();

  return {
    /** Record a one-off entry, e.g. log('version', { changed, file }). */
    log(kind, data) {
      push(kind, data);
    },
    /** Start sending app state snapshots from `fn()`. */
    watch(fn) {
      snapshot = fn;
      sample();
      flush();
    },
  };
}

function describe(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  try {
    return JSON.stringify(value)?.slice(0, MAX_TEXT) ?? String(value);
  } catch {
    return String(value);
  }
}
