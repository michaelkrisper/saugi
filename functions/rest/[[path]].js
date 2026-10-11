// Same-origin relay for the Roborock REST API, which sends no CORS headers.
// /rest/<host>/<path>?<query> -> https://<host>/<path>?<query>

import { ALLOWED_HOST } from '../../shared/relay.js';

const FORWARD = /^(authorization|content-type|header_[a-z]+|x-mercy-ks?)$/;

export async function onRequest({ request, params }) {
  const [host, ...rest] = params.path;
  if (!ALLOWED_HOST.test(host)) return new Response('forbidden', { status: 403 });
  const target = `https://${host}/${rest.join('/')}${new URL(request.url).search}`;
  const headers = new Headers();
  for (const [k, v] of request.headers) if (FORWARD.test(k)) headers.set(k, v);
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
