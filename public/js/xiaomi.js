// Xiaomi cloud (Xiaomi Home) for vacuums that are not in the Roborock app: password
// sign-in with captcha and 2FA code, RC4-signed API calls, miIO RPC through the cloud.
// A port of the login and signing in PiotrMachowski/Xiaomi-cloud-tokens-extractor.
//
// All requests go through `http(url, { method, query, form, cookies, agent })`, which
// never follows redirects and resolves to `{ status, bytes, headers, cookies }`
// (`headers` lower-case, `cookies` the name/value pairs the response set).

import { base64, concat, md5hex, unbase64, utf8 } from './crypto.js';

const ACCOUNT = 'https://account.xiaomi.com';
const SID = 'xiaomiio';
export const COUNTRIES = ['de', 'us', 'sg', 'ru', 'tw', 'in', 'i2', 'cn'];

const td = new TextDecoder();
const digest = async (algo, bytes) => new Uint8Array(await crypto.subtle.digest(algo, bytes));
const random = (n, from, span) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String.fromCharCode(from + (b % span))).join(
    '',
  );

// RC4 as the cloud uses it: the first 1024 key stream bytes are dropped.
export function rc4(key, data) {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = -1024, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    if (n >= 0) out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

export function makeNonce(millis = Date.now(), rand = crypto.getRandomValues(new Uint8Array(8))) {
  const minutes = new Uint8Array(4);
  new DataView(minutes.buffer).setUint32(0, Math.floor(millis / 60000));
  return base64(concat(rand, minutes));
}

export async function signedNonce(ssecurity, nonce) {
  return base64(await digest('SHA-256', concat(unbase64(ssecurity), unbase64(nonce))));
}

async function signature(method, path, params, signed) {
  const parts = [method, path, ...Object.entries(params).map(([k, v]) => `${k}=${v}`), signed];
  return base64(await digest('SHA-1', utf8(parts.join('&'))));
}

// Every parameter is RC4-encrypted; one hash covers the plain values, one the encrypted.
export async function encryptParams(method, path, params, ssecurity, nonce) {
  const signed = await signedNonce(ssecurity, nonce);
  const key = unbase64(signed);
  const plain = { ...params };
  plain.rc4_hash__ = await signature(method, path, plain, signed);
  const out = {};
  for (const [k, v] of Object.entries(plain)) out[k] = base64(rc4(key, utf8(v)));
  out.signature = await signature(method, path, out, signed);
  out.ssecurity = ssecurity;
  out._nonce = nonce;
  return out;
}

export async function decryptResponse(text, ssecurity, nonce) {
  return td.decode(rc4(unbase64(await signedNonce(ssecurity, nonce)), unbase64(text)));
}

const parse = (res) => {
  try {
    return JSON.parse(td.decode(res.bytes).replace('&&&START&&&', ''));
  } catch {
    return {};
  }
};

// Sign-in is a short dialogue: start() and each answer resolve to
// { session } when done, { captcha: <image bytes> } or { code: 'email' | 'phone' }.
export class MiLogin {
  constructor(http) {
    this.http = http;
    this.agent = `${random(18, 97, 26)}-${random(13, 65, 5)} APP/com.xiaomi.mihome APPV/10.5.201`;
    this.jar = { sdkVersion: 'accountsdk-18.8.15', deviceId: random(6, 97, 26) };
  }

  async #request(url, { follow = true, ...opts } = {}) {
    for (let hop = 0; ; hop++) {
      const res = await this.http(url, { ...opts, cookies: this.jar, agent: this.agent });
      Object.assign(this.jar, res.cookies);
      const next = res.headers.location;
      if (!follow || res.status < 300 || res.status >= 400 || !next || hop > 8) return res;
      url = new URL(next, url).href;
      opts = {};
    }
  }

  async start(user, password) {
    this.jar.userId = user;
    const first = parse(
      await this.#request(`${ACCOUNT}/pass/serviceLogin`, { query: { sid: SID, _json: 'true' } }),
    );
    if (first.ssecurity?.length > 4) return this.#finish(first);
    if (!first._sign) throw new Error('Xiaomi did not accept this user name.');
    this.fields = {
      sid: SID,
      hash: md5hex(password).toUpperCase(),
      callback: 'https://sts.api.io.mi.com/sts',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      user,
      _sign: first._sign,
      _json: 'true',
    };
    return this.#auth();
  }

  captcha(code) {
    this.fields.captCode = code;
    return this.#auth();
  }

  async #auth() {
    const res = await this.#request(`${ACCOUNT}/pass/serviceLoginAuth2`, {
      method: 'POST',
      query: this.fields,
      follow: false,
    });
    const json = parse(res);
    if (json.captchaUrl) {
      const img = await this.#request(new URL(json.captchaUrl, ACCOUNT).href);
      return { captcha: img.bytes };
    }
    if (json.ssecurity?.length > 4) return this.#finish(json);
    if (json.notificationUrl) return this.#startCode(json.notificationUrl);
    if (json.code === 70016) throw new Error('Wrong user name or password.');
    throw new Error(
      `Xiaomi sign-in failed: ${json.desc ?? json.description ?? `HTTP ${res.status}`} (${json.code})`,
    );
  }

  async #finish(json) {
    this.ssecurity = json.ssecurity;
    this.userId = json.userId;
    if (json.location) await this.#request(json.location);
    return this.#session();
  }

  #session() {
    const session = {
      userId: String(this.userId ?? this.jar.userId),
      ssecurity: this.ssecurity,
      serviceToken: this.jar.serviceToken,
    };
    if (!session.serviceToken) throw new Error('Xiaomi sign-in failed: no service token.');
    return { session };
  }

  async #startCode(notificationUrl) {
    this.context = new URL(notificationUrl).searchParams.get('context');
    await this.#request(notificationUrl);
    const list = parse(
      await this.#request(`${ACCOUNT}/identity/list`, {
        query: { sid: SID, context: this.context, _locale: 'en_US' },
      }),
    );
    // flag 4: text message, 8: e-mail
    this.flag = list.flag === 4 ? 4 : 8;
    const kind = this.flag === 4 ? 'Phone' : 'Email';
    const sent = parse(
      await this.#request(`${ACCOUNT}/identity/auth/send${kind}Ticket`, {
        method: 'POST',
        query: { _dc: String(Date.now()), sid: SID, context: this.context, mask: '0', _locale: 'en_US' },
        form: { retry: '0', icode: '', _json: 'true', ick: this.jar.ick ?? '' },
      }),
    );
    if (sent.code) throw new Error(`Xiaomi could not send the code: ${sent.tips ?? sent.desc ?? sent.code}`);
    return { code: kind.toLowerCase() };
  }

  async verify(code) {
    const flag = String(this.flag);
    const kind = this.flag === 4 ? 'Phone' : 'Email';
    const base = { sid: SID, context: this.context, _locale: 'en_US' };
    const res = await this.#request(`${ACCOUNT}/identity/auth/verify${kind}`, {
      method: 'POST',
      query: { _flag: flag, _json: 'true', mask: '0', ...base },
      form: { _flag: flag, ticket: code, trust: 'false', _json: 'true', ick: this.jar.ick ?? '' },
      follow: false,
    });
    const json = parse(res);
    if (json.code) throw new Error('The code is wrong or has expired.');
    let next =
      json.location ??
      res.headers.location ??
      `${ACCOUNT}/identity/result/check?${new URLSearchParams(base)}`;
    if (next.includes('identity/result/check')) {
      next = (await this.#request(next, { follow: false })).headers.location;
    }
    if (!next) throw new Error('Xiaomi sign-in failed after the code.');
    // serviceLoginAuth2/end carries ssecurity in a header and redirects to the token service.
    let end = await this.#request(next, { follow: false });
    if (end.status === 200) end = await this.#request(next, { follow: false });
    try {
      this.ssecurity = JSON.parse(end.headers['extension-pragma']).ssecurity;
    } catch {
      // handled below
    }
    const sts =
      end.headers.location ?? td.decode(end.bytes).match(/https:\/\/sts\.api\.io\.mi\.com\/sts[^"]*/)?.[0];
    if (!this.ssecurity || !sts) throw new Error('Xiaomi sign-in failed after the code.');
    await this.#request(sts);
    this.userId = this.jar.userId;
    return this.#session();
  }
}

// The transport for the browser: through the relay functions/mi.
export async function relayHttp(url, { method = 'GET', query, form, cookies, headers = {}, agent } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  const h = { ...headers };
  if (cookies) {
    h['x-mi-cookie'] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  if (agent) h['x-mi-agent'] = agent;
  if (method === 'POST') h['Content-Type'] = 'application/x-www-form-urlencoded';
  // The query travels in a header, as with the Roborock relay: it holds secrets.
  h['x-relay-query'] = u.searchParams.toString();
  const res = await fetch(`/mi/${u.host}${u.pathname}`, {
    method,
    headers: h,
    body: form && new URLSearchParams(form).toString(),
  });
  if (!res.headers.has('x-mi-status')) throw new Error(`Xiaomi relay error (HTTP ${res.status})`);
  return {
    status: Number(res.headers.get('x-mi-status')),
    bytes: new Uint8Array(await res.arrayBuffer()),
    headers: JSON.parse(res.headers.get('x-mi-headers')),
    cookies: JSON.parse(res.headers.get('x-mi-set-cookie')),
  };
}

// Signed API of one region; `session` is what MiLogin resolved to.
export class MiCloud {
  constructor(http, session, country) {
    this.http = http;
    this.session = session;
    this.country = country;
    this.base = `https://${country === 'cn' ? '' : `${country}.`}api.io.mi.com`;
  }

  async call(path, data) {
    const { userId, ssecurity, serviceToken } = this.session;
    const nonce = makeNonce();
    const res = await this.http(`${this.base}/app${path}`, {
      method: 'POST',
      query: await encryptParams('POST', path, { data: JSON.stringify(data) }, ssecurity, nonce),
      cookies: {
        userId,
        serviceToken,
        yetAnotherServiceToken: serviceToken,
        locale: 'en_GB',
        channel: 'MI_APP_STORE',
      },
      headers: { 'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2', 'miot-encrypt-algorithm': 'ENCRYPT-RC4' },
    });
    if (res.status === 401) throw new Error('Xiaomi sign-in expired');
    if (res.status !== 200) throw new Error(`Xiaomi cloud error (HTTP ${res.status})`);
    const json = JSON.parse(await decryptResponse(td.decode(res.bytes), ssecurity, nonce));
    if (json.code) throw new Error(`Xiaomi cloud: ${json.message ?? 'error'} (${json.code})`);
    // An RPC the vacuum did not answer comes back as code 0 with an error object.
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  async devices() {
    return (await this.call('/home/device_list', { getVirtualModel: false, getHuamiDevices: 0 }))?.list ?? [];
  }

  rpc(did, method, params = []) {
    return this.call(`/home/rpc/${did}`, { id: 1 + Math.floor(Math.random() * 9998), method, params });
  }
}

// The same interface as Robot, for a vacuum reached through the Xiaomi cloud. There is
// no connection to hold: it counts as connected while its calls succeed.
export class MiRobot {
  constructor(mi, http = relayHttp) {
    this.cloud = new MiCloud(http, mi.session, mi.country);
    this.did = mi.device.did;
    this.connected = false;
  }

  async rpc(method, params) {
    try {
      const result = await this.cloud.rpc(this.did, method, params);
      this.connected = true;
      return result;
    } catch (err) {
      // A vacuum that does not answer one call is still reachable; a cloud error is not.
      if (/^Xiaomi/.test(err.message)) this.connected = false;
      throw err;
    }
  }

  async status() {
    const [s] = await this.rpc('get_status');
    return s;
  }

  // The map the vacuum stored after its last run: { id, bytes } (litemap.js) or null.
  // There is no map of a run in progress.
  async lastMap() {
    const id = (await this.rpc('get_clean_summary'))[3]?.at(-1);
    if (!id) return null;
    const [name] = await this.rpc('get_clean_record_map', [id]);
    const { url } = await this.cloud.call('/home/getmapfileurl', { obj_name: decodeURIComponent(name) });
    const res = await this.cloud.http(url);
    if (res.status !== 200) throw new Error(`Map download failed (HTTP ${res.status})`);
    return { id, bytes: res.bytes };
  }

  close() {
    this.connected = false;
  }
}
