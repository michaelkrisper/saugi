// Same-origin relay for the Xiaomi cloud (vacuums paired with Xiaomi Home), which
// sends no CORS headers and signs in with cookies and redirects a browser cannot see.
// /mi/<host>/<path> -> https://<host>/<path>?<x-relay-query>
// Cookies and the user agent arrive as x-mi-cookie / x-mi-agent. A redirect is not
// followed: the upstream status, the two headers the sign-in needs and the cookies
// set come back as x-mi-status, x-mi-headers and x-mi-set-cookie (JSON).

import { MI_HOST } from '../../shared/relay.js';

const FORWARD = /^(content-type|x-xiaomi-protocal-flag-cli|miot-encrypt-algorithm)$/;
const EXPOSE = ['location', 'extension-pragma'];

export async function onRequest({ request, params }) {
  const [host, ...rest] = params.path;
  if (!MI_HOST.test(host)) return new Response('forbidden', { status: 403 });
  // The query holds the user name, the password hash and session keys, which do
  // not belong in a URL that proxies may log.
  const query = request.headers.get('x-relay-query');
  const search = query === null ? new URL(request.url).search : `?${new URLSearchParams(query)}`;
  const target = `https://${host}/${rest.join('/')}${search}`;
  const headers = new Headers();
  for (const [k, v] of request.headers) if (FORWARD.test(k)) headers.set(k, v);
  if (request.headers.has('x-mi-cookie')) headers.set('Cookie', request.headers.get('x-mi-cookie'));
  if (request.headers.has('x-mi-agent')) headers.set('User-Agent', request.headers.get('x-mi-agent'));
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    // The app follows the sign-in's redirects itself, each one through the allowlist.
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const cookies = {};
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    const value = pair.slice(i + 1);
    if (i > 0 && value && value !== 'EXPIRED') cookies[pair.slice(0, i).trim()] = value;
  }
  const exposed = {};
  for (const name of EXPOSE) if (res.headers.has(name)) exposed[name] = res.headers.get(name);
  return new Response(res.body, {
    headers: {
      // The app reads the body as bytes (JSON, RC4 text, the captcha picture).
      // Whatever a Xiaomi host sends must never run as a page of this origin.
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'no-store',
      'x-mi-status': String(res.status),
      'x-mi-headers': JSON.stringify(exposed),
      'x-mi-set-cookie': JSON.stringify(cookies),
    },
  });
}
