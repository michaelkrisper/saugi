// The vacuums as the browser sees them: through the server's /api (server/api.js). The
// server holds the sign-in and speaks to Roborock and Xiaomi; nothing secret gets here.

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body && { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (res.ok) return res;
  const error = new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  error.status = res.status;
  throw error;
}

const result = async (path, options) => (await (await call(path, options)).json()).result;

/** { rr: { name, model } | null, rooms, mi: { name, model } | null }; throws with .status 401 when locked. */
export const state = async () => (await call('/state')).json();
export const unlock = (code) => call('/unlock', { method: 'POST', body: { code } });
/** Hands over the sign-in an older version kept in this browser. */
export const adopt = (old) => call('/adopt', { method: 'POST', body: old });

/** Roborock: { email } sends the code, { code } signs in. */
export const rrLogin = async (step) => (await call('/rr/login', { method: 'POST', body: step })).json();
export const signOut = () => call('/rr', { method: 'DELETE' });
/** Xiaomi: { user, password }, then { captcha } or { code }; answers { captcha } (base64), { code } or { done }. */
export const miLogin = async (step) => (await call('/mi/login', { method: 'POST', body: step })).json();
export const miRemove = () => call('/mi', { method: 'DELETE' });

export const getJobs = () => result('/rr/jobs');
export const addJob = (job) => result('/rr/jobs', { method: 'POST', body: job });
export const putJob = (id, job) => result(`/rr/jobs/${id}`, { method: 'PUT', body: job });

const gunzip = async (bytes) =>
  new Uint8Array(
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
  );

/**
 * The Roborock vacuum as the server pushes it (server-sent events, server/feed.js):
 * `status(object)`, `map(bytes)`, `fail({ message, lost, closed })`. `lost`: the vacuum
 * or the server is out of reach; `closed`: the stream is over and has to be opened
 * again (the browser retries a dropped one itself). Returns what ends it.
 */
export function watch({ status, map, fail }) {
  const source = new EventSource('/api/events');
  source.addEventListener('status', (e) => status(JSON.parse(e.data)));
  source.addEventListener('map', async (e) =>
    map(await gunzip(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)))),
  );
  source.addEventListener('fail', (e) => fail(JSON.parse(e.data)));
  source.onerror = () =>
    fail({
      message: 'the server does not answer',
      lost: true,
      closed: source.readyState === EventSource.CLOSED,
    });
  return () => source.close();
}

/** One vacuum ('rr' or 'mi'). It counts as connected while its calls succeed. */
export class RemoteRobot {
  constructor(kind) {
    this.kind = kind;
    this.connected = false;
  }

  async #run(request) {
    try {
      const value = await request();
      this.connected = true;
      return value;
    } catch (err) {
      // A vacuum that refuses or misses one call is still there; the server or its
      // connection to the cloud (502) is not.
      if (err.status === undefined || err.status >= 500) this.connected = false;
      throw err;
    }
  }

  rpc(method, params) {
    return this.#run(() => result(`/${this.kind}/rpc`, { method: 'POST', body: { method, params } }));
  }

  status() {
    return this.#run(() => result(`/${this.kind}/status`));
  }

  /** Xiaomi Home: the map of the last finished run, { id, bytes }, or null. */
  lastMap() {
    return this.#run(async () => {
      const res = await call('/mi/map');
      if (res.status === 204) return null;
      return { id: Number(res.headers.get('x-map-id')), bytes: new Uint8Array(await res.arrayBuffer()) };
    });
  }
}
