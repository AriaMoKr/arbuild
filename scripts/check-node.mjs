// Runs before the Vite scripts (npm's pre* hooks). Vite 8 bundles with Rolldown, whose
// Windows binaries are MSVC builds only. A MinGW-built Node (MSYS2's
// mingw-w64-x86_64-nodejs) makes Rolldown look for a GNU binary that doesn't exist, so
// Vite dies with "Cannot find native binding". Say what's wrong instead.
const mingwNode = process.platform === 'win32' && process.config?.variables?.shlib_suffix === 'dll.a';

if (mingwNode) {
  console.error(`
This project can't run on MSYS2/MinGW Node (${process.execPath}, v${process.versions.node}).
Vite 8's bundler, Rolldown, only ships Windows binaries built for the official (MSVC) Node.

Use the official Windows Node from nodejs.org instead, for example:
  - run npm from PowerShell or cmd, or
  - in the MSYS2 shell:  PATH="/c/Program Files/nodejs:$PATH" npm run dev
`);
  process.exit(1);
}
