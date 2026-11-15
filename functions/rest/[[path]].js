// Same-origin relay for the Roborock REST API, which sends no CORS headers.
// /rest/<host>/<path>?<query> -> https://<host>/<path>?<query>

import { REST_HOST } from '../../shared/relay.js';

const FORWARD = /^(authorization|content-type|header_[a-z]+|x-mercy-ks?)$/;
// Roborock's header_<name> arrives as x-roborock-<name>: the web server in
// front drops header names that contain an underscore.
const RENAMED = /^x-roborock-([a-z]+)$/;

export async function onRequest({ request, params }) {
  const [host, ...rest] = params.path;
  if (!REST_HOST.test(host)) return new Response('forbidden', { status: 403 });
  // The app sends the query in a header: it holds the e-mail address and the
  // sign-in code, which do not belong in a URL that proxies may log.
  const query = request.headers.get('x-relay-query');
  const search = query === null ? new URL(request.url).search : `?${new URLSearchParams(query)}`;
  const target = `https://${host}/${rest.join('/')}${search}`;
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (FORWARD.test(k)) headers.set(k, v);
    else if (RENAMED.test(k)) headers.set(k.replace(RENAMED, 'header_$1'), v);
  }
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    // A redirect would leave the allowlist behind; the API has none.
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return new Response('upstream redirect', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(res.body, {
    status: res.status,
    headers: {
      // The API answers JSON and the app parses nothing else. Whatever a
      // Roborock host sends must never run as a page of this origin, where
      // localStorage holds the Roborock token.
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'no-store',
    },
  });
}
