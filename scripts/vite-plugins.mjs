// Dev-server-only Vite plugins: a plain HTTP mirror of the HTTPS dev server, and the
// receiving end of the debug channel (src/debugChannel.js).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves the dev server over plain HTTP on `port` as well. It runs the same middleware,
 * and hot reload works because websocket upgrades are handed to Vite's own handler.
 * WebXR only runs on secure pages, so over the LAN this is for the 2D page;
 * http://localhost counts as secure, so desktop browsers get the full app.
 */
export function plainHttp({ port }) {
  return {
    name: 'table-cube:plain-http',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer) return; // middleware mode: nothing to mirror
      const mirror = http.createServer(server.middlewares);
      mirror.on('upgrade', (req, socket, head) => server.httpServer.emit('upgrade', req, socket, head));
      mirror.on('error', (err) => server.config.logger.error(`  plain HTTP server on port ${port} failed: ${err.message}`));

      server.httpServer.once('listening', () => {
        const { host } = server.config.server;
        mirror.listen(port, typeof host === 'string' ? host : undefined, () => {
          const urls = [...(server.resolvedUrls?.local ?? []), ...(server.resolvedUrls?.network ?? [])];
          const lines = urls.map((url) => url.replace(/^https:/, 'http:').replace(/:\d+\//, `:${port}/`));
          server.config.logger.info(
            `  HTTP too: ${lines.join('  ')}\n  (WebXR only works over HTTP on localhost; the Quest needs the https:// address)`,
          );
        });
      });
      server.httpServer.once('close', () => {
        mirror.close();
        mirror.closeAllConnections(); // drop keep-alive sockets so a restarted server can take the port at once
      });
    },
  };
}

const MAX_BODY = 512 * 1024;

/**
 * Accepts POST /__debug from the debug channel and appends each entry as a JSON line to
 * `file`. Errors and warnings from the page are echoed in the terminal. With
 * `enabled: false` the endpoint still answers but writes nothing (used by the e2e run).
 */
export function debugLog({ file, enabled = true }) {
  return {
    name: 'table-cube:debug-log',
    apply: 'serve',
    configureServer(server) {
      const logFile = path.resolve(server.config.root, file);
      if (enabled) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), kind: 'server-start' })}\n`);
      }

      server.middlewares.use('/__debug', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_BODY) chunks.push(chunk);
        });
        req.on('end', () => {
          if (size > MAX_BODY) {
            res.statusCode = 413;
            res.end();
            return;
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.statusCode = 400;
            res.end();
            return;
          }
          res.statusCode = 204;
          res.end();
          if (!enabled || !Array.isArray(body.entries)) return;

          const client = {
            ip: req.socket.remoteAddress?.replace(/^::ffff:/, ''),
            device: describeDevice(String(body.ua ?? ''), Boolean(body.emulated)),
          };
          const received = new Date().toISOString();
          const lines = body.entries.map((entry) =>
            JSON.stringify({ t: new Date(entry.at ?? Date.now()).toISOString(), received, ...client, ...entry, at: undefined }),
          );
          fs.appendFile(logFile, `${lines.join('\n')}\n`, (err) => {
            if (err) server.config.logger.error(`  debug log write failed: ${err.message}`);
          });

          for (const entry of body.entries) {
            if (entry.kind === 'error' || (entry.kind === 'console' && (entry.level === 'error' || entry.level === 'warn'))) {
              server.config.logger.warn(`  [${client.device}] ${entry.level ?? 'error'}: ${String(entry.message).slice(0, 500)}`, {
                timestamp: true,
              });
            }
          }
        });
      });
    },
  };
}

function describeDevice(ua, emulated) {
  const quest = ua.match(/Quest\s*\d*\w*/)?.[0];
  if (emulated) return `emulated ${quest ?? 'XR device'}`;
  if (quest) return quest.replace(/\s+/g, ' ');
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Mac OS X/.test(ua)) return 'Mac browser';
  if (/Android/.test(ua)) return 'Android browser';
  return 'browser';
}
