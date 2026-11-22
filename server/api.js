// /api: what the app in the browser talks to. Everything but /api/unlock needs the
// code word's cookie (server/access.js); the vacuums are reached by server/vacuums.js.
import { json } from './access.js';
import { Refused } from './vacuums.js';

const body = async (request) => (await request.json().catch(() => null)) ?? {};
const done = (result) => json({ result: result ?? null });
const bytes = (data, headers = {}) =>
  new Response(data, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...headers },
  });
// Server-sent events: the Roborock vacuum's status and map as they change. The stream
// ends when the browser leaves (server/node.js cancels it).
function events(vacuums) {
  const encoder = new TextEncoder();
  let stop;
  const stream = new ReadableStream({
    // A refusal thrown here leaves the constructor and becomes an ordinary answer.
    start(controller) {
      const leave = vacuums.rrWatch((event, data) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)),
      );
      // A silent connection is one that proxies close.
      const beat = setInterval(() => controller.enqueue(encoder.encode(':\n\n')), 25_000);
      beat.unref?.();
      stop = () => {
        clearInterval(beat);
        leave();
      };
    },
    cancel: () => stop(),
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

// "METHOD /path" -> (vacuums, request, match) => Response
const ROUTES = [
  ['GET /api/state', (v) => json(v.state())],
  ['POST /api/adopt', async (v, r) => done(v.adopt(await body(r)))],
  ['POST /api/rr/login', async (v, r) => json(await v.rrLogin(await body(r)))],
  ['DELETE /api/rr', (v) => done(v.signOut())],
  ['GET /api/rr/status', async (v) => done(await v.rrStatus())],
  ['GET /api/events', (v) => events(v)],
  [
    'POST /api/rr/rpc',
    async (v, r) => {
      const { method, params } = await body(r);
      return done(await v.rrRpc(method, params));
    },
  ],
  ['GET /api/rr/jobs', async (v) => done(await v.rrJobs().list())],
  ['POST /api/rr/jobs', async (v, r) => done(await v.rrJobs().add(await body(r)))],
  ['PUT /api/rr/jobs/(\\d+)', async (v, r, m) => done(await v.rrJobs().put(m[1], await body(r)))],
  ['POST /api/mi/login', async (v, r) => json(await v.miLogin(await body(r)))],
  ['DELETE /api/mi', (v) => done(v.miRemove())],
  ['GET /api/mi/status', async (v) => done(await v.miStatus())],
  [
    'GET /api/mi/map',
    async (v) => {
      const last = await v.miMap();
      return last ? bytes(last.bytes, { 'x-map-id': String(last.id) }) : json(null, 204);
    },
  ],
  [
    'POST /api/mi/rpc',
    async (v, r) => {
      const { method, params } = await body(r);
      return done(await v.miRpc(method, params));
    },
  ],
].map(([route, run]) => [new RegExp(`^${route}$`), run]);

/** Whether the call makes Roborock or Xiaomi send a code or checks a password. */
export const signsIn = (pathname) => /^\/api\/(rr|mi)\/login$/.test(pathname);

export async function api(vacuums, request, pathname) {
  for (const [route, run] of ROUTES) {
    const match = route.exec(`${request.method} ${pathname}`);
    if (!match) continue;
    try {
      return await run(vacuums, request, match);
    } catch (err) {
      // The app shows the message: a refusal of ours, or what the vacuum's cloud said.
      return json({ error: err.message }, err instanceof Refused ? err.status : 502);
    }
  }
  return json({ error: 'not found' }, 404);
}
