// Entry point on the own server: plain Node for the app's /api. Only requests
// for files that do not exist in public/ arrive here; the web server in front
// (Caddy; scripts/dev.mjs locally) serves public/ itself. The one exception is
// "/": Caddy passes directories on, so the start page is answered here.
//
//   PORT=8806 node server/node.js
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createAccess, json } from './access.js';
import { api, signsIn } from './api.js';
import { clientKey, createLimiter } from './limit.js';
import { createVacuums } from './vacuums.js';

// The app posts small forms and JSON (login, schedules).
const MAX_BODY = 256 * 1024;

// Per client. The steps that make Roborock or Xiaomi send a code or check a password.
const CODE_LIMIT = { capacity: 6, perMs: 600_000 };
// Guesses of the code word.
const UNLOCK_LIMIT = { capacity: 5, perMs: 600_000 };
// Commands, the Xiaomi Home vacuum's status every 3 s while it moves, a retried event stream.
const API_LIMIT = { capacity: 180, perMs: 60_000 };

const INDEX = new URL('../public/index.html', import.meta.url);

const text = (body, status) => new Response(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * The api is for this app only: a request that names another site as its origin
 * is refused. Browsers send Origin with every request that is not a GET or HEAD,
 * same-origin ones included; `required` is for those. A same-origin GET carries
 * no Origin, and Sec-Fetch-Site is missing in older Safari, so there is nothing
 * to demand there.
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

/** Turns Node's request into a Request. Null: body too large. */
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

/** The request's URL, or null for a target that is none (`//[`). */
function parse(incoming) {
  try {
    return new URL(incoming.url, 'http://localhost');
  } catch {
    return null;
  }
}

const busy = () =>
  new Response('{"error":"Too many requests. Please try again later."}', {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function handleApi(incoming, url, client, limits, { access, vacuums }) {
  if (!access.enabled) return json({ error: 'No code word is set on the server.' }, 404);
  const unlocks = url.pathname === '/api/unlock' && incoming.method === 'POST';
  if (!unlocks && !access.allowed(incoming.headers)) return json({ error: 'locked' }, 401);
  if (!limits.api(client) || (signsIn(url.pathname) && !limits.code(client))) return busy();
  const request = await toRequest(incoming);
  if (!request) return text('too large', 413);
  if (unlocks) return access.unlock(request, () => limits.unlock(client));
  return api(vacuums, request, url.pathname);
}

async function handle(incoming, limits, gate) {
  const url = parse(incoming);
  if (!url) return text('bad request', 400);
  const reads = ['GET', 'HEAD'].includes(incoming.method);
  if (url.pathname === '/' && reads) {
    return new Response(readFileSync(INDEX), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }
  if (!url.pathname.startsWith('/api/')) return text('not found', 404);
  if (!sameOrigin(incoming.headers, !reads)) return text('forbidden', 403);
  return handleApi(incoming, url, clientKey(incoming), limits, gate);
}

/** `options`: { access, vacuums } for tests (see server/access.js, server/vacuums.js). */
export function createApp(options) {
  const limits = {
    code: createLimiter(CODE_LIMIT),
    unlock: createLimiter(UNLOCK_LIMIT),
    api: createLimiter(API_LIMIT),
  };
  const access = createAccess(options?.access);
  const vacuums = createVacuums({ store: access.store, ...options?.vacuums });
  const app = createServer(async (incoming, outgoing) => {
    try {
      const response = await handle(incoming, limits, { access, vacuums });
      if (response.status === 413) outgoing.setHeader('connection', 'close');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const body = Readable.fromWeb(response.body).on('error', () => outgoing.destroy());
        // An event stream ends when its browser leaves: that cancels it.
        outgoing.on('close', () => body.destroy());
        body.pipe(outgoing);
      } else outgoing.end();
    } catch (error) {
      console.error('api:', error.cause?.code ?? error.name);
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'cache-control': 'no-store' });
      outgoing.end('error');
    }
  });
  // The vacuums' connection would keep the process alive.
  const close = app.close.bind(app);
  app.close = (done) => {
    vacuums.close();
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
