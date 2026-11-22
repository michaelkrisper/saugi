// Access by code word, and where the server keeps the vacuums' sign-in.
//
// With SITE_CODE set, /api and the relays answer only to a browser that has sent the
// code word once (POST /api/unlock); it then holds a cookie derived from the code
// word, so changing the word locks everyone out. The sign-in (server/vacuums.js) lies
// in DATA_DIR/config.json and never leaves the server. Without SITE_CODE there is no
// /api (the app says so) and the relays are open as before.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COOKIE = 'roscoe_access';
const YEAR = 365 * 24 * 3600;
export const json = (body, status = 200, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createAccess({ code = process.env.SITE_CODE, dir = process.env.DATA_DIR } = {}) {
  const token = code ? createHmac('sha256', code).update('roscoe access v1').digest('hex') : null;
  const file = dir ? join(dir, 'config.json') : null;
  // Without a directory (local development) the sign-in lasts as long as the process.
  let memory = null;

  const read = () => {
    if (!file) return memory;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const write = (config) => {
    if (!file) {
      memory = config;
      return;
    }
    if (config === null) return rmSync(file, { force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(config), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const cookie = (value, age) =>
    `${COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;

  /** Whether the request may use the relays and the shared sign-in. */
  const allowed = (headers) => {
    if (!token) return true;
    const sent = `; ${headers.cookie ?? ''}`.split(`; ${COOKIE}=`)[1]?.split(';')[0] ?? '';
    return same(sent, token);
  };

  /** POST /api/unlock. `mayTry` says whether this client may guess the code word again. */
  async function unlock(request, mayTry) {
    if (!mayTry()) return json({ error: 'Too many attempts. Please try again later.' }, 429);
    const given = (await request.json().catch(() => null))?.code;
    if (typeof given !== 'string' || !same(given.trim(), code))
      return json({ error: 'Wrong code word.' }, 403);
    return json(null, 204, { 'set-cookie': cookie(token, YEAR) });
  }

  return { enabled: !!token, allowed, unlock, store: { read, write } };
}
