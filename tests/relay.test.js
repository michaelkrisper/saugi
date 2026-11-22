// The REST function must only reach Roborock hosts and only forward the headers
// the API needs.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { onRequest } from '../functions/rest/[[path]].js';
import { MI_HOST, MQTT_HOST, REST_HOST } from '../shared/relay.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('only the regional Roborock hosts the app uses are allowed', () => {
  for (const host of [
    'euiot.roborock.com',
    'usiot.roborock.com',
    'api-eu.roborock.com',
    'api-cn-2.roborock.com',
  ])
    assert.ok(REST_HOST.test(host) && !MQTT_HOST.test(host), host);
  for (const host of ['mqtt-eu-3.roborock.com', 'mqtt-us.roborock.com'])
    assert.ok(MQTT_HOST.test(host) && !REST_HOST.test(host), host);
  for (const host of [
    'roborock.com',
    'www.roborock.com',
    'wood-eu.roborock.com',
    'xxiot.roborock.com',
    'evil.com',
    'euiot.roborock.com.evil.com',
    'evilroborock.com',
    'a.euiot.roborock.com',
    'euiot.roborock.com:8080',
    'user@euiot.roborock.com',
    'EUIOT.ROBOROCK.COM',
  ])
    assert.ok(!REST_HOST.test(host) && !MQTT_HOST.test(host), host);
});

test('foreign hosts are refused without a request', async () => {
  globalThis.fetch = () => assert.fail('must not fetch');
  const res = await onRequest({
    request: new Request('https://roscoe.krisperapps.de/rest/evil.com/x'),
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
  const request = new Request('https://roscoe.krisperapps.de/rest/euiot.roborock.com/api/v1/login?a=1&b=2', {
    method: 'POST',
    body: 'payload',
    headers: {
      Authorization: 'Hawk id="x"',
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-roborock-clientid': 'abc',
      'x-roborock-clientlang': 'en',
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
    'header_clientlang',
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
    request: new Request('https://roscoe.krisperapps.de/rest/euiot.roborock.com/api'),
    params: { path: ['euiot.roborock.com', 'api'] },
  });
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
});

test('the query may travel in a header instead of the URL', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response('{}');
  };
  await onRequest({
    request: new Request('https://roscoe.krisperapps.de/rest/euiot.roborock.com/api/v1/getUrlByEmail', {
      method: 'POST',
      headers: { 'x-relay-query': 'email=a%2Bb%40example.com&needtwostepauth=false' },
    }),
    params: { path: ['euiot.roborock.com', 'api', 'v1', 'getUrlByEmail'] },
  });
  assert.equal(
    seen.url,
    'https://euiot.roborock.com/api/v1/getUrlByEmail?email=a%2Bb%40example.com&needtwostepauth=false',
  );
  assert.equal(seen.init.headers.has('x-relay-query'), false);
});

test('a redirect is not followed', async () => {
  let init;
  globalThis.fetch = async (_url, i) => {
    init = i;
    return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:8806/' } });
  };
  const res = await onRequest({
    request: new Request('https://roscoe.krisperapps.de/rest/euiot.roborock.com/x'),
    params: { path: ['euiot.roborock.com', 'x'] },
  });
  assert.equal(init.redirect, 'manual');
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('Location'), null);
});

test('whatever the upstream host sends is labelled JSON and cannot run as a page', async () => {
  globalThis.fetch = async () =>
    new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } });
  const res = await onRequest({
    request: new Request('https://roscoe.krisperapps.de/rest/euiot.roborock.com/x'),
    params: { path: ['euiot.roborock.com', 'x'] },
  });
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'");
});

test('only Xiaomi cloud hosts are reached', () => {
  for (const host of [
    'account.xiaomi.com',
    'api.io.mi.com',
    'de.api.io.mi.com',
    'sts.api.io.mi.com',
    'awsde0.fds.api.xiaomi.com',
  ])
    assert.ok(MI_HOST.test(host), host);
  for (const host of [
    'xiaomi.com',
    'evil.com',
    'account.xiaomi.com.evil.com',
    'a.b.api.io.mi.com',
    'evilapi.io.mi.com',
    'xx.api.io.mi.com',
    'a.b.fds.api.xiaomi.com',
    'fds.api.xiaomi.com',
    'mi.com',
  ])
    assert.ok(!MI_HOST.test(host), host);
});
