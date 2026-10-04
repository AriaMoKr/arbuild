# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A WebXR `immersive-ar` app for Meta Quest 3. It runs in Meta Quest Browser and puts a small dig site (an excavator, its operator, a worker and some rocks, built from boxes, cylinders and spheres) at the centre of a table taken from the user's Space Setup. It's plain JS (ES modules, no TypeScript) with three.js 0.186 and Vite 8, and it needs Node 22.12 or newer.

## Commands

```bash
npm run dev                                   # HTTPS dev server on 0.0.0.0:5173 (strictPort)
npm test                                      # unit tests (node --test, auto-discovers test/*.test.js)
node --test --test-name-pattern="TableTracker"   # run matching unit tests only
npm run test:e2e                              # headless Chrome + Quest emulator, screenshots in e2e-output/
npm run build                                 # static site in dist/ (base './')
```

- **Tests:** there's no linter or formatter configured. `npm test` must stay `node --test` with no path: Node 22 treats a directory argument as a module and runs nothing.
- **Dev server:** `.claude/launch.json` has a `dev` config for the preview tool.
- **Windows Node:** Vite 8's bundler (Rolldown) ships only MSVC Windows binaries, so MinGW-built Node (MSYS2's `C:\msys64\mingw64\bin\node.exe`, which is first on PATH in the user's MSYS2 shell) crashes with "Cannot find native binding". Forcing the MSVC binding via `NAPI_RS_NATIVE_LIBRARY_PATH` isn't a fix: `vite build` then panics with "Node-API symbol has not been loaded". `scripts/check-node.mjs` runs as the `predev`/`prebuild`/`prepreview`/`pretest:e2e` hook and exits with an explanation instead. Use `C:\Program Files\nodejs`.
- **Quest access:** the headset loads `https://<pc-lan-ip>:5173/` over Wi-Fi and clicks through the self-signed certificate. WebXR needs a secure context, so plain HTTP over the LAN won't work. On this PC the Node firewall rules only allowed Public networks, so the Quest just spun until an inbound rule for TCP 5173 on the Private profile was added (see README).

## Architecture

- **`src/main.js`** is the entry point. In dev only (`import.meta.env.DEV`), and when the browser lacks native `immersive-ar` (or `?emulate=1`), it dynamically imports `src/emulation.js` *before* importing `src/app.js`. Two things depend on that order: three captures `XRWebGLBinding` when the renderer is constructed, and IWER replaces `navigator.xr`. Keep emulation behind the `import.meta.env.DEV` check so `vite build` drops IWER entirely; check with `grep -ri iwer dist`.
- **`src/app.js`** (`initApp()`) owns the renderer, the session lifecycle, the per-frame loop and the UI states. Each frame it runs `findTables` (planes first; meshes only if no table planes exist, since Quest reports every table both ways), then `TableTracker.update`, `placeSite`, `describeState` and `messageFor` for the status panel. In-AR state lives in the `run` object, which is reset on `sessionstart` and `sessionend`.
- **`src/tableLocator.js`** holds all the geometry and table-selection logic. It's pure, with no three.js or DOM, so it can be unit-tested. It works on column-major matrices exactly as `XRRigidTransform.matrix` gives them.
- **`src/digSite.js`** builds the dig site in three.js, using the numbers from the Excavator Blockout design canvas (design units, y up, front +Z where the worker faces; `SITE_UNIT` is 0.5 mm, so it's about 42 × 20 cm). `createDigSite()` returns the `site` group, the excavator's `paint` material, its `height`, and its footprint `radius`: a circle round the origin that holds every part *and* the contact shadows. `app.js` uses that radius both to shrink the site on small tables (`SITE_FIT`) and for the slide limits. Because it's a circle, spinning at an edge never pushes anything off the table and the shadows never need cropping.
- **`src/controllerInput.js`** maps the Touch controllers to dig site controls. The left thumbstick slides the site across the table: `slideOnTable` keeps `run.offset` in the table's frame, relative to where the user is facing, and clamps it to the table top; `app.js` calls it via `moveSite`. The right thumbstick spins the site (`site.rotation.y`, on top of the anchor's table yaw), and holding A cycles the excavator's paint hue in sRGB, via `applyControllerInput`. It's pure, like `tableLocator.js`. The anchor sits at the table centre plus `tableOffsetToWorld(offset)`. Whenever the locked table changes, the offset resets to 0 and the spin is set by `quarterTurnToward` so the site faces the user while staying square to the table.
- **`src/statusPanel.js`** draws the in-headset text panel on a canvas. Quest has no `dom-overlay`. Changing the text recreates the `CanvasTexture`, because the canvas height changes and three allocates immutable texture storage.
- **`src/emulation.js`** sets up IWER and `@iwer/sem` synthetic rooms. The `?env=` and `?planes=1` query params apply only on the dev server.
- **`scripts/e2e.mjs`** starts Vite programmatically (port 5199), drives Chrome over raw CDP with Node's global `WebSocket`, and uses the dev-only hooks `window.__app` (`startAR`, `endAR`, `selectNext`, `snapshot()`) and `window.__iwer.xrDevice`. Its expected table coordinates come from the `@iwer/sem` capture files for `meeting_room` and `living_room`.

## WebXR and Quest facts the code depends on

These were verified against specs, package source and a real Quest 3. Don't "simplify" them away:

- **Plane normal sign.** The sign of planeSpace +Y isn't fixed by the spec, and on Quest/IWER table planes it points down. Never offset along the plane normal or copy the plane's full rotation. Lift along reference-space +Y and take yaw only (`yawFromMatrix`).
- **Plane polygons.** They are closed loops on Quest/IWER (the first vertex repeated), so use the area-weighted centroid, not a vertex average.
- **Table meshes.** In IWER they are Z-up boxes with the origin at the top face. Measure in reference space (`tableTopFromMesh`).
- **Labels.** Accept `table` and the legacy `desk`, case-insensitive, possibly comma-separated.
- **Lock identity.** XRPlane/XRMesh objects keep their identity across frames, so `TableTracker` locks by object identity. Cycling order is anchored to where the viewer stood when the lock was made (`origin`), not to their current position. All plane/mesh references are invalid after the session ends.
- **No `ARButton`.** three's `ARButton` forces the `local` reference space. The app uses its own button, probes `local-floor`, and calls `setReferenceSpaceType` before `setSession`.
- **Optional features.** All scene features (`local-floor`, `plane-detection`, `mesh-detection`, `hand-tracking`) are optional so that a denied permission doesn't block AR. Use `session.enabledFeatures` to explain what's missing. IWER rejects `requestReferenceSpace('local-floor')` unless it was requested.
- **Room capture.** `initiateRoomCapture()` works once per session, needs `plane-detection`, and doesn't exist in IWER, so feature-detect it.
- **Scene data timing.** On a real Quest it can take 2–3 s to arrive (`SCAN_GRACE_MS`). Under IWER it's there from the first frame, and IWER bumps `lastChangedTime` every frame.
- **Controller layout.** Quest Touch controllers use the `xr-standard` gamepad layout: on both controllers `axes[2]`/`axes[3]` are the thumbstick, and its y is negative when pushed forward (`axes[0]`/`axes[1]` are always-0 touchpad placeholders). `buttons[4]` is A on the right controller and X on the left. In IWER, drive them with `controllers.left`/`controllers.right` `.updateAxes('thumbstick', x, y)` and `updateButtonValue('a-button', 1)`.
- **Passthrough.** It needs `scene.background` to stay null; three clears to transparent in `alpha-blend`.
- **IWER setup.** It needs `installRuntime({ forceInstall: true })` on desktop Chrome, and `installSEM(SyntheticEnvironmentModule)` takes the class, not an instance; the package README's API name is stale. IWER only produces frames in a visible, non-zero-size viewport.
