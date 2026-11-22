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

// "METHOD /path" -> (vacuums, request, match) => Response
const ROUTES = [
  ['GET /api/state', (v) => json(v.state())],
  ['POST /api/adopt', async (v, r) => done(v.adopt(await body(r)))],
  ['POST /api/rr/login', async (v, r) => json(await v.rrLogin(await body(r)))],
  ['DELETE /api/rr', (v) => done(v.signOut())],
  ['GET /api/rr/status', async (v) => done(await v.rrStatus())],
  ['GET /api/rr/map', async (v) => bytes(await v.rrMap())],
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
