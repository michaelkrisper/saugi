// The own server's entry point over real HTTP: what it answers besides the api
// (tests/access.test.js), and that nothing of the former relays is left.

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../server/node.js';

let app;
let base;
before(async () => {
  app = createApp({ access: { code: 'open sesame', dir: undefined } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

test('the start page is answered here, since the proxy passes directories on', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), /<title>/);
});

/** A request as fetch() would not send it; resolves with the status line's code. */
function raw(path, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path, headers });
    request.on('response', (res) => resolve(res.resume().statusCode));
    request.on('upgrade', (res, socket) => resolve(socket.destroy() && res.statusCode));
    request.on('error', reject);
    request.end();
  });
}

test('there is nothing but the start page and the api: no relay, no upgrade', async () => {
  const upgrade = { connection: 'Upgrade', upgrade: 'websocket', origin: base };
  for (const path of [
    '/nothing',
    '/js/app.js',
    '/rest/euiot.roborock.com/x',
    '/mi/de.api.io.mi.com/x',
    '/mqtt?host=mqtt-eu-3.roborock.com&port=8883',
  ]) {
    assert.equal(await raw(path), 404, path);
    assert.equal(await raw(path, upgrade), 404, path);
  }
  assert.equal((await fetch(`${base}/`, { method: 'POST', headers: { origin: base } })).status, 404);
  assert.equal(await raw('//['), 400);
  assert.equal(await raw('//[', upgrade), 400);
  // Still there.
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('the api takes requests from this site only, with a small body', async () => {
  const unlock = (headers, body = '{"code":"x"}') =>
    fetch(`${base}/api/unlock`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.9', ...headers },
      body,
    });
  // Browsers send Origin with every POST: without it, it is not the app.
  assert.equal((await unlock({})).status, 403);
  assert.equal((await unlock({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await unlock({ origin: base, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await unlock({ origin: base })).status, 403);
  assert.equal((await unlock({ origin: base }, 'x'.repeat(300 * 1024))).status, 413);
  const foreign = await fetch(`${base}/api/state`, { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
});

test('the api is limited per client, sign-in steps more tightly', async () => {
  const unlocked = await fetch(`${base}/api/unlock`, {
    method: 'POST',
    headers: { origin: base, 'cf-connecting-ip': '203.0.113.1' },
    body: '{"code":"open sesame"}',
  });
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const from = (ip, path = '/api/state', init = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { cookie, origin: base, 'cf-connecting-ip': ip } });
  // 180 a minute, refilled as the test runs: a few more may pass.
  const passed = async (ip) => {
    for (let n = 0; n < 200; n++) if ((await from(ip(n))).status !== 200) return n;
    return 200;
  };
  const mine = await passed(() => '203.0.113.1');
  assert.ok(mine >= 179 && mine < 190, String(mine));
  const refused = await from('203.0.113.1');
  assert.equal(refused.status, 429);
  assert.match((await refused.json()).error, /Too many requests/);
  // Others are not affected; one IPv6 /64 is one client.
  assert.equal((await from('203.0.113.2')).status, 200);
  assert.ok((await passed((n) => `2001:db8:0:1::${n + 1}`)) < 190);
  assert.equal((await from('2001:db8:0:2::1')).status, 200);

  // No code is requested: the step is refused for lack of an address, but it counts.
  const step = () => from('203.0.113.3', '/api/rr/login', { method: 'POST', body: '{}' });
  for (let i = 0; i < 6; i++) assert.equal((await step()).status, 400);
  assert.equal((await step()).status, 429);
  assert.equal((await from('203.0.113.3')).status, 200);
});
