// Roborock cloud REST API (login + home data). Requests go through the
// same-origin relay functions/rest because the API sends no CORS headers.

import { base64, hmacSha256Base64, md5, md5hex } from './crypto.js';

const BASE_URLS = [
  'https://euiot.roborock.com',
  'https://usiot.roborock.com',
  'https://cniot.roborock.com',
  'https://ruiot.roborock.com',
];

function relay(url) {
  const u = new URL(url);
  return `/rest/${u.host}${u.pathname}${u.search}`;
}

async function call(url, { method = 'POST', params, form, headers = {} } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  const init = { method, headers: { ...headers } };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(relay(u.href), init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Roborock-API antwortet unerwartet (${res.status})`);
  }
}

const ERRORS = {
  2008: 'Für diese E-Mail gibt es kein Roborock-Konto.',
  2018: 'Der Code ist falsch oder abgelaufen.',
  3009: 'Bitte zuerst in der Roborock-App die Nutzungsbedingungen akzeptieren.',
  3006: 'Bitte in der Roborock-App die Nutzungsbedingungen erneut akzeptieren.',
  9002: 'Zu viele Code-Anfragen. Bitte später nochmal.',
};

function check(res) {
  if (res?.code !== 200) throw new Error(ERRORS[res?.code] ?? `${res?.msg ?? 'Fehler'} (Code ${res?.code})`);
  return res.data;
}

const randomString = (n) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join('');
};

export class LoginFlow {
  constructor(email) {
    this.email = email.trim();
    this.clientId = base64(md5(this.email + randomString(22)));
  }

  async requestCode() {
    for (const base of BASE_URLS) {
      const data = check(
        await call(`${base}/api/v1/getUrlByEmail`, {
          params: { email: this.email, needtwostepauth: 'false' },
        }),
      );
      if (data.country != null || data.countrycode != null) {
        Object.assign(this, { baseUrl: data.url, country: data.country, countryCode: data.countrycode });
        break;
      }
    }
    if (!this.baseUrl) throw new Error(ERRORS[2008]);
    const headers = { header_clientid: this.clientId, header_clientlang: 'en' };
    const res = await call(`${this.baseUrl}/api/v4/email/code/send`, {
      form: { email: this.email, type: 'login', platform: '' },
      headers,
    });
    if (res.code === 200) return;
    // Older accounts only work with the v1 endpoint.
    check(
      await call(`${this.baseUrl}/api/v1/sendEmailCode`, {
        params: { username: this.email, type: 'auth' },
        headers,
      }),
    );
    this.legacy = true;
  }

  async login(code) {
    const headers = { header_clientid: this.clientId };
    if (this.legacy) {
      const params = { username: this.email, verifycode: code, verifycodetype: 'AUTH_EMAIL_CODE' };
      return check(await call(`${this.baseUrl}/api/v1/loginWithCode`, { params, headers }));
    }
    const ks = randomString(16);
    const { k } = check(await call(`${this.baseUrl}/api/v3/key/sign`, { params: { s: ks }, headers }));
    let agreement = { majorVersion: 14, minorVersion: 0 };
    const latest = await call(`${this.baseUrl}/api/v3/app/agreement/latest`, {
      method: 'GET',
      params: { country: this.country },
      headers: { header_clientlang: 'en' },
    }).catch(() => null);
    if (latest?.code === 200 && Number.isInteger(latest.data?.majorVersion)) {
      agreement = { majorVersion: latest.data.majorVersion, minorVersion: latest.data.minorVersion };
    }
    const res = await call(`${this.baseUrl}/api/v4/auth/email/login/code`, {
      form: { country: this.country, countryCode: this.countryCode, email: this.email, code, ...agreement },
      headers: {
        ...headers,
        'x-mercy-ks': ks,
        'x-mercy-k': k,
        header_clientlang: 'en',
        header_appversion: '4.54.02',
        header_phonesystem: 'iOS',
        header_phonemodel: 'iPhone16,1',
      },
    });
    return check(res);
  }
}

export async function hawk(rriot, path, ts = Math.floor(Date.now() / 1000), nonce = randomString(8)) {
  const pre = [rriot.u, rriot.s, nonce, ts, md5hex(path), '', ''].join(':');
  const mac = await hmacSha256Base64(rriot.h, pre);
  return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${ts}",nonce="${nonce}",mac="${mac}"`;
}

export async function fetchHome(baseUrl, userData) {
  const detail = check(
    await call(`${baseUrl}/api/v1/getHomeDetail`, {
      method: 'GET',
      headers: { Authorization: userData.token, header_clientid: base64(md5(randomString(16))) },
    }),
  );
  const path = `/v3/user/homes/${detail.rrHomeId}`;
  const res = await call(userData.rriot.r.a + path, {
    method: 'GET',
    headers: { Authorization: await hawk(userData.rriot, path) },
  });
  if (!res.success) throw new Error(`Gerätedaten nicht abrufbar: ${res.msg ?? JSON.stringify(res)}`);
  return res.result;
}
