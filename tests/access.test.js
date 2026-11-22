// The code word gate and the server's API, through the real Node entry. No vacuum is
// reached: the sign-in handed over is made up, and only calls that need none are made.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../server/node.js';

const closers = [];
after(() => {
  for (const close of closers) close();
});

async function start(access) {
  const app = createApp({ access });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  closers.push(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  return (path, { cookie, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: { origin: base, ...(cookie && { cookie }), ...init.headers },
      body: init.body && JSON.stringify(init.body),
    });
}

const SIGN_IN = {
  userData: {
    rriot: {
      u: 'user',
      s: 'secret',
      h: 'hawk',
      k: 'key',
      r: { a: 'https://api-eu.roborock.com', m: 'ssl://mqtt-eu-3.roborock.com:8883' },
    },
  },
  device: { duid: 'duid', name: 'Roscoe', localKey: 'abcdEFGH12345678', model: 'roborock.vacuum.a15' },
  rooms: { 1: 'Bad' },
  mi: {
    session: { userId: '1', ssecurity: 'c2VjcmV0', serviceToken: 'token' },
    country: 'de',
    device: { did: '2', name: 'Dusty', model: 'roborock.vacuum.a01' },
  },
};

test('without a code word there is no api and the relays are open', async () => {
  const call = await start({ code: '', dir: undefined });
  assert.equal((await call('/api/state')).status, 404);
  assert.equal((await call('/mi/evil.com/x')).status, 403);
});

test('the code word opens the api and the relays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saugi-access-'));
  const call = await start({ code: 'open sesame', dir });
  assert.equal((await call('/')).status, 200);
  for (const path of ['/api/state', '/api/rr/status', '/mi/evil.com/x', '/rest/evil.com/x'])
    assert.equal((await call(path)).status, 401, path);
  assert.equal((await call('/mqtt?host=mqtt-eu-3.roborock.com&port=8883')).status, 401);
  assert.equal((await call('/api/state', { cookie: 'roscoe_access=nope' })).status, 401);
  assert.equal((await call('/api/adopt', { method: 'POST', body: SIGN_IN })).status, 401);

  assert.equal((await call('/api/unlock', { method: 'POST', body: { code: 'wrong' } })).status, 403);
  const unlocked = await call('/api/unlock', { method: 'POST', body: { code: ' open sesame ' } });
  assert.equal(unlocked.status, 204);
  const set = unlocked.headers.get('set-cookie');
  assert.match(set, /^roscoe_access=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  const cookie = set.split(';')[0];

  // Past the gate the relay's own allowlist answers.
  assert.equal((await call('/mi/evil.com/x', { cookie })).status, 403);
  assert.deepEqual(await (await call('/api/state', { cookie })).json(), { rr: null, rooms: {}, mi: null });
  assert.equal((await call('/api/rr/status', { cookie })).status, 409);
  assert.equal((await call('/api/mi/status', { cookie })).status, 409);
  assert.equal((await call('/api/adopt', { method: 'POST', cookie, body: { device: {} } })).status, 400);

  // A sign-in handed over stays on the server: the app gets names, never a key.
  assert.equal((await call('/api/adopt', { method: 'POST', cookie, body: SIGN_IN })).status, 200);
  assert.equal((await call('/api/adopt', { method: 'POST', cookie, body: SIGN_IN })).status, 409);
  const state = await (await call('/api/state', { cookie })).text();
  assert.deepEqual(JSON.parse(state), {
    rr: { name: 'Roscoe', model: 'roborock.vacuum.a15' },
    rooms: { 1: 'Bad' },
    mi: { name: 'Dusty', model: 'roborock.vacuum.a01' },
  });
  for (const secret of ['secret', 'hawk', 'abcdEFGH12345678', 'c2VjcmV0', 'token', 'duid'])
    assert.ok(!state.includes(secret), secret);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')), SIGN_IN);

  // Only the calls the app makes are passed on.
  for (const kind of ['rr', 'mi']) {
    const res = await call(`/api/${kind}/rpc`, {
      method: 'POST',
      cookie,
      body: { method: 'app_goto_target' },
    });
    assert.equal(res.status, 400, kind);
  }
  assert.equal((await call('/api/nothing', { cookie })).status, 404);

  // The sign-in survives a restart, and another code word locks the old cookie out.
  const again = await start({ code: 'open sesame', dir });
  assert.equal((await (await again('/api/state', { cookie })).json()).rr.name, 'Roscoe');
  const other = await start({ code: 'changed', dir });
  assert.equal((await other('/api/state', { cookie })).status, 401);

  assert.equal((await call('/api/mi', { method: 'DELETE', cookie })).status, 200);
  assert.equal((await (await call('/api/state', { cookie })).json()).mi, null);
  assert.equal((await call('/api/rr', { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual(await (await call('/api/state', { cookie })).json(), { rr: null, rooms: {}, mi: null });
});

test('guessing the code word is limited, and a foreign site may not try', async () => {
  const call = await start({ code: 'open sesame', dir: undefined });
  const foreign = await call('/api/unlock', {
    method: 'POST',
    body: { code: 'open sesame' },
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);
  const tries = [];
  for (let i = 0; i < 6; i++)
    tries.push((await call('/api/unlock', { method: 'POST', body: { code: 'x' } })).status);
  assert.deepEqual(tries, [403, 403, 403, 403, 403, 429]);
  assert.equal((await call('/api/unlock', { method: 'POST', body: { code: 'open sesame' } })).status, 429);
});
