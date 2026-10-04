# Table Cube

A WebXR passthrough AR app for **Meta Quest 3**. It reads your room setup, finds a table, and puts a small dig site at the centre of the table top: a wheeled excavator with its operator, a worker in a hard hat and a pile of rocks, built from simple boxes, cylinders and spheres. It's about 42 × 20 cm, and shrinks to fit smaller tables. It runs in Meta Quest Browser and is served from your PC over Wi-Fi. There is nothing to install on the headset.

## Requirements

- Meta Quest 3 or 3S, with a room scan that includes a table (see below).
- A PC with Node.js 22.12 or newer, on the same network as the headset. On Windows, use the official Node from nodejs.org: MSYS2's MinGW build of Node can't run Vite 8, and `npm run dev` will stop with an explanation if it's the `node` on your PATH.

## Run it on the Quest

```bash
npm install
npm run dev
```

Vite prints one or more `Network:` lines such as `https://192.168.1.23:5173/`. Use the one for your Wi-Fi or Ethernet adapter. Addresses that belong to VirtualBox, WSL or Hyper-V adapters (often `192.168.56.x` or `172.x.x.x`) aren't reachable from the headset. On the Quest:

1. Open **Meta Quest Browser** and go to that `https://…:5173/` address.
2. The browser warns that the connection isn't private, because the dev server uses a self-signed certificate. Choose **Advanced › Proceed**. WebXR only works on secure (https) pages, which is why plain `http://` won't do. The browser remembers this choice for about a week, so expect the warning again after that, after the PC's address changes, or after the certificate is regenerated (it's valid for a year; deleting `node_modules/.vite` also regenerates it).
3. Tap **Enter AR**. When the browser asks about **spatial data**, choose **Allow**; the app needs it to find the table. It may also ask about **hand tracking**. Allow that if you want to pinch; controllers work either way.

The dev server also serves the same app over plain HTTP on port 5174. On the Quest that page loads, but WebXR stays off because it isn't a secure page, so use the `https://…:5173` address there. On the PC, `http://localhost:5174/` counts as secure and works without the certificate warning.

### If the page never loads on the Quest

If the Quest keeps loading and never even shows the certificate warning, its requests aren't reaching the PC. Usually Windows Firewall is the cause:

- The first time Node.js listens on the network, Windows asks whether to allow it. If it was ever allowed only on **Public** networks, or the prompt was dismissed, Windows silently blocks it on **Private** networks and doesn't ask again. Fix it in one of two ways:
  - Allow just this port on private networks. In an **Administrator** PowerShell:
    ```powershell
    New-NetFirewallRule -DisplayName "Vite dev 5173 (Quest)" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private
    ```
  - Or go to Windows Security › Firewall & network protection › Allow an app through firewall › Change settings, and tick **Private** for **Node.js JavaScript Runtime**.
- The PC's network profile should be **Private** (Settings › Network & internet › your connection › Network profile type).
- The headset must be on the same network. Guest networks and networks with client isolation block device-to-device traffic.

### Room setup

The app uses the room model from Space Setup, not live camera detection. In the headset, go to **Settings › Physical space › Space setup** and scan the room. Quest 3 labels most tables automatically. If yours isn't recognised, add it during Space Setup and label it **Table**.

## Using the app

The dig site goes on the nearest table, preferring one in front of you when it's about as close (a table you're not facing counts as 1.5 m further away). While the room's tables are still arriving at the start of a session the app keeps re-picking, until you choose a table yourself or slide or spin the site. It lines up with the table's edges and is turned to face you. Until you've looked at it, the panel tells you which way to turn.

| You see | What to do |
| --- | --- |
| The dig site on a table | That's it. It follows the table's orientation and stands on its surface. On a small table it's scaled down so every part, shadows included, stays on the table. |
| "Table 1 of 3" | Pull the trigger or pinch to move the dig site to the next table. Tables are counted outward from where you stood when it was first placed. |
| "No room setup found" / "No table in your room setup" | Pull the trigger or pinch to open Space Setup (once per AR session), or exit and use Settings › Physical space › Space setup. |
| "Spatial data is blocked" | Exit AR and tap the site-info icon at the left of the address bar. On a normal HTTPS site it's a lock; on the dev server it's a **Not secure** warning. Set spatial data to **Allow**, and reload. |
| Left thumbstick | Push it to slide the dig site across the table: forward moves it away from you, right moves it to your right, whichever way the table is turned. It stops at the table's edge. Moving to another table puts it back at that table's centre. |
| Right thumbstick | Push it to spin the dig site slowly: right turns it clockwise, left anticlockwise, and the further you push the faster it turns. |
| Hold **A** | The excavator's paint cycles through colours while you hold it, and keeps the colour it reached when you let go. |
| The menu above your left controller (or left hand) | Point at it with the right controller (or pinch with your right hand) and pull the trigger: **Exit AR** ends the session, **↻ Reload page** reloads the app (handy after a code change, since the browser's own controls are out of reach in AR). Its bottom line shows when the app's files last changed ("Updated …"), the same as under the title on the page, so you can tell whether the headset is running the latest version. |
| Pinch does nothing | Use a controller trigger, or allow hand tracking from the same site-info icon and reload. |

To leave AR, use **Exit AR** on the menu above your left hand, or press the Meta button: Quest Browser shows controls near the address bar to resume or quit the immersive session. If something prevented the dig site from appearing, the page repeats what to fix after you leave AR.

## Developing without a headset

`npm run dev` and open `http://localhost:5174/` (or `https://localhost:5173/`) in desktop Chrome or Edge. When the browser has no real AR support, the dev build loads Meta's [Immersive Web Emulation Runtime](https://github.com/meta-quest/immersive-web-emulation-runtime) and a scanned synthetic room, so **Enter AR** works on the desktop. The emulator is never included in `npm run build`.

Query parameters (dev server only):

| Parameter | Effect |
| --- | --- |
| `?env=meeting_room` | Synthetic room to load: `meeting_room` (default, one table), `office_small`, `living_room` (four tables), `office_large`, `music_room`. |
| `?planes=1` | Draw the emulated planes and furniture boxes. |
| `?emulate=1` / `?emulate=0` | Force the emulator on or off. |

### Debug log

In dev builds, the page sends its console output, uncaught errors and a snapshot of the app's state back to the dev server, which appends them to `logs/quest-debug.jsonl` (one JSON object per line). That works from the headset too, with no USB cable. The snapshot covers detected tables, placement, frame rate and controllers, and is sent whenever something changes and every 10 s during AR. Errors and warnings from the page are also printed in the `npm run dev` terminal. It also records which table was picked and why (`[tables] …`), every menu button press (`[menu] …`), and how long the shaders took to compile before AR (`[shaders] …`). Add `?debug=0` to the URL to turn it off. None of this is in `npm run build`.

Tests:

```bash
npm test          # unit tests for the table geometry and selection logic
npm run test:e2e  # headless Chrome + emulator: checks the dig site lands on the right tables
```

`test:e2e` needs Chrome or Edge installed (set `CHROME_PATH` if it isn't found) and writes screenshots to `e2e-output/`.

## How it works

1. **Session.** `navigator.xr.requestSession('immersive-ar')` with `local-floor`, `plane-detection`, `mesh-detection` and `hand-tracking` as *optional* features. Making them optional means a denied permission doesn't block AR; the app checks `session.enabledFeatures` and explains what's missing instead. three.js renders with a transparent clear, so passthrough shows behind the dig site.
2. **Finding tables.** Every frame, the app reads `frame.detectedPlanes` and keeps horizontal planes whose `semanticLabel` is `table` (or the older `desk`). If there are no such planes, it falls back to `frame.detectedMeshes` (Quest also exposes each table as a box volume).
3. **Centre of the table.** The table top's polygon is in plane space. The app takes its area-weighted centroid and transforms it into the reference space. It never trusts the direction of the plane's normal: on Quest the table plane's +Y axis points *down*, so the dig site is lifted along the reference space's up axis. Only the plane's yaw is copied, so the site lines up with the table edges.
4. **Which table.** The app picks the nearest table, counting tables outside your view 1.5 m further away, then stays locked on that `XRPlane` object, so the dig site doesn't jump when you walk around. Quest delivers the room's tables over the first frames, so that first pick is provisional: it's made again whenever the set of tables changes, until you press the trigger, slide or spin. Trigger or pinch cycles through the tables, ordered by distance from where you stood when the table was picked.
5. **Messages.** Quest Browser has no DOM overlay in AR, so status text is drawn on a canvas panel that follows your head.

The geometry and selection logic lives in [src/tableLocator.js](src/tableLocator.js) and has no three.js or browser dependency.

## Hosting without the PC

`npm run build` writes a static site to `dist/` with relative paths. Upload it to any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages) and open that URL in Quest Browser.

## Project layout

```
index.html              2D landing page with the Enter AR button
src/main.js             entry point; loads the emulator in dev when needed
src/app.js              renderer, AR session, per-frame table tracking, dig site placement
src/digSite.js          the dig site: excavator, operator, worker and rocks from boxes, cylinders and spheres
src/tableLocator.js     table detection maths and table selection (pure, unit-tested)
src/statusPanel.js      in-headset text panel
src/xrMenu.js           in-AR menu above the left hand: Exit AR, Reload page, "Updated …"
src/version.js          fetches ./__version.json, when the app's files last changed
src/emulation.js        dev-only Quest 3 emulator setup (IWER + synthetic rooms)
src/debugChannel.js     dev-only: sends console output, errors and state to the dev server
test/                   unit tests (node --test)
scripts/e2e.mjs         headless end-to-end test
scripts/vite-plugins.mjs  dev server extras: the plain-HTTP port, the debug log endpoint and ./__version.json
vite.config.js          HTTPS dev server on the LAN, build settings
```
