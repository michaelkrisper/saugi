// The REST relay must only reach Roborock hosts and only forward the headers
// the API needs.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { onRequest } from '../functions/rest/[[path]].js';
import { ALLOWED_HOST } from '../shared/relay.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('only single-label roborock.com subdomains are allowed', () => {
  for (const host of ['euiot.roborock.com', 'api-eu.roborock.com', 'mqtt-eu-3.roborock.com'])
    assert.ok(ALLOWED_HOST.test(host), host);
  for (const host of [
    'roborock.com',
    'evil.com',
    'euiot.roborock.com.evil.com',
    'evilroborock.com',
    'a.b.roborock.com',
    'euiot.roborock.com:8080',
    'user@euiot.roborock.com',
    'EUIOT.ROBOROCK.COM',
  ])
    assert.ok(!ALLOWED_HOST.test(host), host);
});

test('foreign hosts are refused without a request', async () => {
  globalThis.fetch = () => assert.fail('must not fetch');
  const res = await onRequest({
    request: new Request('https://saugi.pages.dev/rest/evil.com/x'),
    params: { path: ['evil.com', 'x'] },
  });
  assert.equal(res.status, 403);
});

test('path, query, method, body and allowed headers are passed through', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response('{"ok":1}', {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1' },
    });
  };
  const request = new Request('https://saugi.pages.dev/rest/euiot.roborock.com/api/v1/login?a=1&b=2', {
    method: 'POST',
    body: 'payload',
    headers: {
      Authorization: 'Hawk id="x"',
      'Content-Type': 'application/x-www-form-urlencoded',
      header_clientid: 'abc',
      'x-mercy-ks': 'k',
      Cookie: 'secret=1',
      'X-Forwarded-For': '1.2.3.4',
    },
  });
  const res = await onRequest({ request, params: { path: ['euiot.roborock.com', 'api', 'v1', 'login'] } });

  assert.equal(seen.url, 'https://euiot.roborock.com/api/v1/login?a=1&b=2');
  assert.equal(seen.init.method, 'POST');
  assert.equal(Buffer.from(seen.init.body).toString(), 'payload');
  assert.deepEqual([...seen.init.headers.keys()].sort(), [
    'authorization',
    'content-type',
    'header_clientid',
    'x-mercy-ks',
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Set-Cookie'), null);
  assert.deepEqual(await res.json(), { ok: 1 });
});

test('GET requests are sent without a body', async () => {
  let init;
  globalThis.fetch = async (_url, i) => {
    init = i;
    return new Response('[]');
  };
  await onRequest({
    request: new Request('https://saugi.pages.dev/rest/euiot.roborock.com/api'),
    params: { path: ['euiot.roborock.com', 'api'] },
  });
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
});
