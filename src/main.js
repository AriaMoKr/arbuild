import './style.css';

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
  if (flag === null) {
    // Decide before IWER installs: it replaces navigator.xr and spoofs the user agent.
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
