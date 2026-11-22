// The vacuums, as the server sees them. It holds the sign-in (Roborock: MQTT keys and
// the device key; Xiaomi: the session) and speaks the protocols itself, with the same
// modules the browser used to run (public/js). The browser gets names, status, maps
// and results, never a key.
import { connect as tlsConnect } from 'node:tls';
import { onRequest as rest } from '../functions/rest/[[path]].js';
import { addJob, fetchHome, getJobs, LoginFlow, putJob, useTransport } from '../public/js/api.js';
import { Robot } from '../public/js/robot.js';
import { COUNTRIES, MiCloud, MiLogin, MiRobot } from '../public/js/xiaomi.js';
import { MI_HOST, MQTT_HOST } from '../shared/relay.js';

// What the app calls; nothing else is passed on to a vacuum.
const RR_METHODS = new Set([
  'get_status',
  'get_room_mapping',
  'app_start',
  'app_pause',
  'app_charge',
  'resume_zoned_clean',
  'resume_segment_clean',
  'set_custom_mode',
  'get_server_timer',
  'set_server_timer',
  'upd_server_timer',
]);
const MI_METHODS = new Set([
  'get_status',
  'app_start',
  'app_pause',
  'app_charge',
  'resume_zoned_clean',
  'resume_segment_clean',
  'set_custom_mode',
  'get_timer',
  'set_timer',
  'upd_timer',
  'del_timer',
]);

// The broker connection is dropped when nobody has asked for this long.
const IDLE_MS = 5 * 60_000;
// A started sign-in waits this long for its code.
const FLOW_MS = 15 * 60_000;

/** An error the app shows as it is; `status` is the HTTP status of the answer. */
export class Refused extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// api.js builds requests for the relay; here they go straight into the relay function.
useTransport((path, init) => {
  const url = new URL(path, 'http://localhost');
  return rest({
    request: new Request(url, init),
    params: { path: url.pathname.slice('/rest/'.length).split('/') },
  });
});

// The broker speaks MQTT over TLS; MqttClient wants something like a WebSocket.
function brokerSocket(host, port) {
  if (!MQTT_HOST.test(host) || port !== 8883) throw new Error('unexpected broker');
  const ws = { readyState: 0 };
  const socket = tlsConnect({ host, port, servername: host });
  socket.setTimeout(120_000, () => socket.destroy());
  socket.on('secureConnect', () => {
    ws.readyState = 1;
    ws.onopen?.();
  });
  socket.on('data', (chunk) => ws.onmessage?.({ data: chunk }));
  socket.on('error', () => {});
  socket.on('close', () => {
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
  });
  ws.send = (bytes) => socket.write(bytes);
  ws.close = () => socket.destroy();
  return ws;
}

// The Xiaomi modules' transport (see xiaomi.js), without the relay.
async function miHttp(url, { method = 'GET', query, form, cookies = {}, headers = {}, agent } = {}) {
  const u = new URL(url);
  if (!MI_HOST.test(u.host)) throw new Error('unexpected host');
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  const h = { ...headers };
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (jar.length) h.Cookie = jar.join('; ');
  if (agent) h['User-Agent'] = agent;
  if (method === 'POST') h['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(u, {
    method,
    headers: h,
    redirect: 'manual',
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const set = {};
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    const value = pair.slice(i + 1);
    if (i > 0 && value && value !== 'EXPIRED') set[pair.slice(0, i).trim()] = value;
  }
  return {
    status: res.status,
    bytes: new Uint8Array(await res.arrayBuffer()),
    headers: Object.fromEntries(res.headers),
    cookies: set,
  };
}

/** `store`: { read(), write(config | null) } for the sign-in; `open`, `http`: for tests. */
export function createVacuums({ store, open = brokerSocket, http = miHttp }) {
  let config = store.read();
  let robot = null;
  let connecting = null;
  let idle = null;
  let rrFlow = null;
  let miFlow = null;

  const keep = () => store.write(config);
  const drop = () => {
    clearTimeout(idle);
    robot?.close();
    robot = null;
    connecting = null;
  };

  /** The connected Roborock vacuum. One connection serves every browser. */
  async function rr() {
    if (!config?.device) throw new Refused('Not signed in.', 409);
    clearTimeout(idle);
    idle = setTimeout(drop, IDLE_MS);
    idle.unref?.();
    if (robot?.connected) return robot;
    connecting ??= (async () => {
      const next = new Robot(config.userData.rriot, config.device, open);
      try {
        await next.connect();
        robot = next;
        return next;
      } catch (err) {
        next.close();
        throw err;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  function mi() {
    if (!config?.mi) throw new Refused('No Xiaomi Home vacuum.', 409);
    return new MiRobot(config.mi, http);
  }

  function allowed(methods, method) {
    if (!methods.has(method)) throw new Refused('This call is not supported.');
  }

  const fresh = (flow) => flow && Date.now() - flow.at < FLOW_MS;

  return {
    /** What a browser may know: names and rooms. */
    state() {
      const name = (d) => d && { name: d.name, model: d.model };
      return {
        rr: name(config?.device) ?? null,
        rooms: config?.rooms ?? {},
        mi: name(config?.mi?.device) ?? null,
      };
    },

    async rrRpc(method, params) {
      allowed(RR_METHODS, method);
      return (await rr()).rpc(method, params);
    },
    async rrStatus() {
      return (await rr()).status();
    },
    async rrMap() {
      return (await rr()).map();
    },
    rrJobs() {
      if (!config?.device) throw new Refused('Not signed in.', 409);
      const { rriot } = config.userData;
      const { duid } = config.device;
      return {
        list: () => getJobs(rriot, duid),
        add: (job) => addJob(rriot, duid, job),
        put: (id, job) => putJob(rriot, duid, id, job),
      };
    },

    /** Step one: { email }, Roborock mails a code. Step two: { code }. */
    async rrLogin({ email, code }) {
      if (typeof email === 'string' && email.trim()) {
        const flow = new LoginFlow(email);
        await flow.requestCode();
        rrFlow = { flow, at: Date.now() };
        return { sent: flow.email };
      }
      if (typeof code !== 'string' || !fresh(rrFlow))
        throw new Refused('Start again with your e-mail address.');
      const { flow } = rrFlow;
      const userData = await flow.login(code.trim());
      const home = await fetchHome(flow.baseUrl, userData);
      const products = Object.fromEntries((home.products ?? []).map((p) => [p.id, p]));
      const d = [...(home.devices ?? []), ...(home.receivedDevices ?? [])].find(
        (d) => (d.pv ?? '1.0') === '1.0',
      );
      if (!d) throw new Refused('No supported vacuum found in this account.');
      config = {
        ...config,
        userData: { rriot: userData.rriot },
        device: { duid: d.duid, name: d.name, localKey: d.localKey, model: products[d.productId]?.model },
        rooms: Object.fromEntries((home.rooms ?? []).map((r) => [r.id, r.name])),
      };
      keep();
      rrFlow = null;
      drop();
      return { done: true };
    },

    signOut() {
      config = null;
      keep();
      drop();
    },

    async miRpc(method, params) {
      allowed(MI_METHODS, method);
      return mi().rpc(method, params);
    },
    miStatus() {
      return mi().status();
    },
    miMap() {
      return mi().lastMap();
    },

    /** { user, password }, then { captcha } or { code } as often as Xiaomi asks. */
    async miLogin({ user, password, captcha, code }) {
      if (!config?.device) throw new Refused('Not signed in.', 409);
      let step;
      if (typeof user === 'string' && typeof password === 'string') {
        miFlow = { login: new MiLogin(http), at: Date.now() };
        step = await miFlow.login.start(user.trim(), password);
      } else if (!fresh(miFlow)) throw new Refused('Start again with your user name and password.');
      else if (typeof captcha === 'string') step = await miFlow.login.captcha(captcha.trim());
      else if (typeof code === 'string') step = await miFlow.login.verify(code.trim());
      else throw new Refused('Start again with your user name and password.');
      if (step.captcha) return { captcha: Buffer.from(step.captcha).toString('base64') };
      if (!step.session) return { code: step.code };
      miFlow = null;
      for (const country of COUNTRIES) {
        const list = await new MiCloud(http, step.session, country).devices().catch(() => []);
        const d = list.find((d) => /^(roborock|rockrobo)\.vacuum\./.test(d.model));
        if (!d) continue;
        config.mi = { session: step.session, country, device: { did: d.did, name: d.name, model: d.model } };
        keep();
        return { done: true };
      }
      throw new Refused('No Roborock vacuum found in this Xiaomi account.');
    },

    miRemove() {
      if (!config?.mi) return;
      delete config.mi;
      keep();
    },

    /** A browser that was signed in before the server kept the sign-in hands it over. */
    adopt(old) {
      if (config?.device) throw new Refused('Already signed in.', 409);
      const rriot = old?.userData?.rriot;
      const d = old?.device;
      if (!rriot?.u || !rriot?.k || !rriot?.r?.m || !d?.duid || !d?.localKey)
        throw new Refused('Nothing to adopt.');
      config = { userData: { rriot }, device: d, rooms: old.rooms ?? {} };
      const m = old.mi;
      if (
        m?.session?.ssecurity &&
        m?.session?.serviceToken &&
        m?.device?.did &&
        COUNTRIES.includes(m.country)
      ) {
        config.mi = { session: m.session, country: m.country, device: m.device };
      }
      keep();
    },

    close: drop,
  };
}
