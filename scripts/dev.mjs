/**
 * Local development in one command: the same Node entry as on the server, plus
 * what Caddy does there (serving public/).
 *
 *   npm run dev            http://localhost:8792
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { createApp } from '../server/node.js';

const PUBLIC = resolve(import.meta.dirname, '../public');
const PORT = Number(process.env.PORT ?? 8792);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** True when the file was sent; false when public/ has no such file. */
function serveFile(request, response) {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(PUBLIC, `.${path}`);
  if (!file.startsWith(PUBLIC + sep)) return false;
  let body;
  try {
    body = readFileSync(file);
  } catch {
    return false;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}

// The app needs a code word on the server; locally it is "dev" unless SITE_CODE says otherwise.
process.env.SITE_CODE ??= 'dev';
const app = createApp();
createServer((request, response) => {
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  if (!(isRead && serveFile(request, response))) app.emit('request', request, response);
})
  .on('upgrade', (request, socket, head) => app.emit('upgrade', request, socket, head))
  .listen(PORT, '127.0.0.1', () => {
    console.info(`\n  http://localhost:${PORT}\n`);
  });
