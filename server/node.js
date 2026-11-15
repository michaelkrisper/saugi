// Entry point on the own server: plain Node for the two relays. Only requests
// for files that do not exist in public/ arrive here; the web server in front
// (Caddy; scripts/dev.mjs locally) serves public/ itself. The one exception is
// "/": Caddy passes directories on, so the start page is answered here.
//
//   PORT=8806 node server/node.js
import { readFileSync } from 'node:fs';
import { createServer, STATUS_CODES } from 'node:http';
import { Readable } from 'node:stream';
import { onRequest as rest } from '../functions/rest/[[path]].js';
import { createMqttRelay, target } from './mqtt.js';

// The app posts small forms and JSON (login, schedules).
const MAX_BODY = 256 * 1024;

const INDEX = new URL('../public/index.html', import.meta.url);

const text = (body, status) => new Response(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * The relays are for this app only: a request that names another site as its
 * origin is refused. Browsers send Origin with every WebSocket handshake and
 * every POST; `required` is for the handshake.
 */
export function sameOrigin(headers, required = false) {
  if (headers['sec-fetch-site'] && !['same-origin', 'none'].includes(headers['sec-fetch-site'])) return false;
  const origin = headers.origin;
  if (!origin) return !required;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

async function readAll(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Turns Node's request into the Request the function expects. Null: body too large. */
export async function toRequest(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const proto = headers.get('x-forwarded-proto') ?? 'http';
  const url = `${proto}://${headers.get('host') ?? 'localhost'}${incoming.url}`;
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const body = hasBody ? await readAll(incoming) : undefined;
  if (body === null) return null;
  return new Request(url, { method: incoming.method, headers, body });
}

async function handle(incoming) {
  const url = new URL(incoming.url, 'http://localhost');
  if (url.pathname === '/mqtt') {
    // Same answers as the upgrade path gives; a plain request never gets further.
    if (!target(url) || !sameOrigin(incoming.headers)) return text('forbidden', 403);
    return text('websocket expected', 426);
  }
  if (url.pathname === '/' && ['GET', 'HEAD'].includes(incoming.method)) {
    return new Response(readFileSync(INDEX), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }
  if (!url.pathname.startsWith('/rest/')) return text('not found', 404);
  if (!sameOrigin(incoming.headers)) return text('forbidden', 403);
  const request = await toRequest(incoming);
  if (!request) return text('too large', 413);
  // /rest/<host>/<path>: the segments of the function's [[path]] parameter.
  return rest({ request, params: { path: url.pathname.slice('/rest/'.length).split('/') } });
}

function refuse(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** `options` go to the MQTT relay (tests replace the upstream connection). */
export function createApp(options) {
  const mqtt = createMqttRelay(options);
  const app = createServer(async (incoming, outgoing) => {
    try {
      const response = await handle(incoming);
      if (response.status === 413) outgoing.setHeader('connection', 'close');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        Readable.fromWeb(response.body)
          .on('error', () => outgoing.destroy())
          .pipe(outgoing);
      else outgoing.end();
    } catch (error) {
      console.error('rest relay:', error.cause?.code ?? error.name);
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'cache-control': 'no-store' });
      outgoing.end('upstream error');
    }
  });
  app.on('upgrade', (incoming, socket, head) => {
    const url = new URL(incoming.url, 'http://localhost');
    const to = url.pathname === '/mqtt' && target(url);
    if (!to || !sameOrigin(incoming.headers, true)) return refuse(socket, 403);
    if (mqtt.full) return refuse(socket, 503);
    mqtt.upgrade(incoming, socket, head, to);
  });
  // Bridged sockets would keep the server open for as long as the app is in use.
  const close = app.close.bind(app);
  app.close = (done) => {
    mqtt.close();
    app.closeAllConnections();
    return close(done);
  };
  return app;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8806);
  const app = createApp();
  // Loopback only: the proxy is the one way in.
  app.listen(port, '127.0.0.1', () => console.info(`saugi: http://127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close(() => process.exit(0)));
}
