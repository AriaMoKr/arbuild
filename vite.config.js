import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR only runs on secure pages, so the dev server uses HTTPS with a self-signed
// certificate. The Quest reaches it over Wi-Fi at https://<this-pc's-ip>:5173 and
// shows a certificate warning (Advanced > Proceed); the browser remembers that for
// about a week.
export default defineConfig({
  base: './', // relative asset URLs, so dist/ works from any static host or sub-path
  plugins: [basicSsl({ name: 'quest-table-cube', ttlDays: 365 })],
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
});
