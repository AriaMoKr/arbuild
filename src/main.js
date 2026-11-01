import './style.css';

// Built copies only: the service worker (scripts/sw-dist.mjs) makes the app installable and keeps
// it working offline after the first visit. The dev server never registers it, so changes show up.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// Dev builds only: send console output, errors and app state back to the dev server
// (logs/quest-debug.jsonl), so problems on the headset are visible without USB debugging.
// Started first so it also catches errors while the app starts.  ?debug=0  turns it off.
let debug = null;
if (import.meta.env.DEV && new URLSearchParams(location.search).get('debug') !== '0') {
  const { startDebugChannel } = await import('./debugChannel.js');
  debug = startDebugChannel();
}

// Desktop development only: emulate a Quest 3 in a synthetic room (Meta's IWER) when
// the browser has no real AR support. `vite build` drops this block entirely, so
// nothing emulation-related ever ships to the headset.
//   ?emulate=1  force emulation      ?emulate=0  never emulate
//   ?env=<room> living_room | meeting_room (default) | music_room | office_large | office_small
//   ?planes=1   draw the emulated planes and furniture boxes
if (import.meta.env.DEV) {
  const params = new URLSearchParams(location.search);
  const flag = params.get('emulate');
  let emulate = flag === '1';
  if (flag === null && window.isSecureContext) {
    // Decide before IWER installs: it replaces navigator.xr and spoofs the user agent.
    // On an insecure page (plain HTTP over the LAN) WebXR is missing for a different
    // reason, and the page should say so rather than emulate.
    emulate = !(await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false));
  }
  if (emulate) {
    const { installEmulation } = await import('./emulation.js');
    await installEmulation({
      env: params.get('env') ?? undefined,
      showPlanes: params.get('planes') === '1',
    });
  }
}

// Imported after the emulator so three.js sees the emulated WebXR globals.
const { initApp } = await import('./app.js');
const app = initApp();
if (import.meta.env.DEV) window.__app = app; // test hook for scripts/e2e.mjs
debug?.watch(app.snapshot);

// "Updated …": when the app's files last changed, so you can tell which version is running.
const { fetchVersion } = await import('./version.js');
fetchVersion().then((version) => {
  if (!version) return;
  document.getElementById('version').textContent = version.text;
  app.setVersion(version.text);
  debug?.log('version', { changed: version.changed, file: version.file });
});
