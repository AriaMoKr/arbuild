import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { debugLog, plainHttp } from './scripts/vite-plugins.mjs';

// WebXR only runs on secure pages, so the dev server uses HTTPS with a self-signed
// certificate. The Quest reaches it over Wi-Fi at https://<this-pc's-ip>:5173 and
// shows a certificate warning (Advanced > Proceed); the browser remembers that for
// about a week. The same app is also served over plain HTTP on HTTP_PORT.
const HTTP_PORT = 5174;

export default defineConfig(({ mode }) => {
  // scripts/e2e.mjs starts its own server in 'e2e' mode: no extra port, no debug log.
  const e2e = mode === 'e2e';
  return {
    base: './', // relative asset URLs, so dist/ works from any static host or sub-path
    plugins: [
      basicSsl({ name: 'quest-table-cube', ttlDays: 365 }),
      ...(e2e ? [] : [plainHttp({ port: HTTP_PORT })]),
      debugLog({ file: 'logs/quest-debug.jsonl', enabled: !e2e }), // see src/debugChannel.js
    ],
    server: {
      host: true, // listen on the LAN, not only localhost
      port: 5173,
      strictPort: true, // fail loudly instead of silently moving to another port
    },
    preview: {
      host: true,
      port: 4173,
      strictPort: true,
    },
    resolve: {
      dedupe: ['three'], // the emulator packages bundle their own three; share the app's
    },
    optimizeDeps: {
      include: ['iwer', '@iwer/sem'], // pre-bundle up front so the dev page doesn't reload mid-test
    },
    build: {
      chunkSizeWarningLimit: 1000, // three.js alone is ~500 kB minified
    },
  };
});
