// The own server's entry point: real HTTP and WebSocket round trips through
// server/node.js. The broker is a local TLS echo server with a certificate for
// *.roborock.com, so the bridge's TLS (including the host name check) is real.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { connect as tlsConnect, createServer as createTlsServer } from 'node:tls';
import { createApp } from '../server/node.js';

const BROKER = 'mqtt-eu-3.roborock.com';
const realFetch = globalThis.fetch;
const closers = [];
let base;
let wsBase;
let cert;
let brokerPort;
const brokerSockets = new Set();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

/** An app whose bridge connects to the local port instead of the real broker. */
async function start(connect, options = {}) {
  const app = createApp({ connect, ...options });
  await listen(app);
  closers.push(() => app.close());
  return `127.0.0.1:${app.address().port}`;
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saugi-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
    ].concat(
      ['-subj', '/CN=broker', '-addext', 'subjectAltName=DNS:*.roborock.com'],
      ['-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
    ),
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'));
  const broker = createTlsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (socket) => {
    brokerSockets.add(socket);
    socket.on('close', () => brokerSockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (chunk.toString() === 'bye') socket.end();
      else socket.write(chunk);
    });
  });
  rmSync(dir, { recursive: true, force: true });
  await listen(broker);
  brokerPort = broker.address().port;
  closers.push(() => broker.close());

  const host = await start((options) =>
    tlsConnect({ ...options, host: '127.0.0.1', port: brokerPort, ca: cert }),
  );
  base = `http://${host}`;
  wsBase = `ws://${host}`;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  for (const close of closers) close();
  for (const socket of brokerSockets) socket.destroy();
});

/** Opens a WebSocket; resolves with it once open, rejects when the handshake is refused. */
function open(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('refused'));
  });
}
const next = (ws, event) => new Promise((resolve) => ws.addEventListener(event, resolve, { once: true }));
// Node's WebSocket sends no Origin by itself; browsers always do.
const origin = () => ({ origin: base });

test('bytes pass through the bridge in both directions, unchanged and in order', async () => {
  const ws = await open(`${wsBase}/mqtt?host=${BROKER}&port=8883`, origin());
  const sent = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
  const received = [];
  const done = new Promise((resolve) => {
    ws.onmessage = (e) => {
      received.push(Buffer.from(e.data));
      if (Buffer.concat(received).length >= sent.length + 2) resolve();
    };
  });
  ws.send(new Uint8Array([0x10, 0x00]));
  ws.send(sent);
  await done;
  assert.deepEqual(Buffer.concat(received), Buffer.concat([Buffer.from([0x10, 0x00]), sent]));

  // The broker hangs up: the browser side is closed too.
  ws.send('bye');
  const closed = await next(ws, 'close');
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, 'upstream closed');
});

test('closing the browser side closes the upstream connection', async () => {
  const ws = await open(`${wsBase}/mqtt?host=${BROKER}&port=8883`, origin());
  ws.send('x');
  await next(ws, 'message');
  assert.equal(brokerSockets.size, 1);
  const [socket] = brokerSockets;
  const gone = new Promise((resolve) => socket.on('close', resolve));
  ws.close();
  await gone;
});

test('the bridge only reaches Roborock brokers on 8883, and only from this site', async () => {
  const refused = (path, headers = origin()) => assert.rejects(open(`${wsBase}${path}`, headers), path);
  await refused('/mqtt?host=evil.com&port=8883');
  await refused('/mqtt?host=127.0.0.1&port=8883');
  await refused(`/mqtt?host=${BROKER}&port=443`);
  await refused(`/mqtt?host=${BROKER}`);
  await refused(`/mqtt?host=${BROKER}&port=8883`, { origin: 'https://evil.example' });
  await refused(`/mqtt?host=${BROKER}&port=8883`, {});
  await refused(`/other?host=${BROKER}&port=8883`);
  assert.equal(brokerSockets.size, 0);

  // Without an upgrade, as the function answered.
  assert.equal((await realFetch(`${base}/mqtt?host=evil.com&port=8883`)).status, 403);
  assert.equal((await realFetch(`${base}/mqtt?host=${BROKER}&port=8883`)).status, 426);
});

test('a certificate that is not the broker’s, or no broker at all, ends with an upstream error', async () => {
  // Without the test CA the local broker is not trusted.
  const untrusted = await start((options) => tlsConnect({ ...options, host: '127.0.0.1', port: brokerPort }));
  let ws = await open(`ws://${untrusted}/mqtt?host=${BROKER}&port=8883`, { origin: `http://${untrusted}` });
  assert.equal((await next(ws, 'close')).code, 1011);

  const dead = createTcpServer();
  await listen(dead);
  const { port } = dead.address();
  dead.close();
  const nowhere = await start((options) => tlsConnect({ ...options, host: '127.0.0.1', port }));
  ws = await open(`ws://${nowhere}/mqtt?host=${BROKER}&port=8883`, { origin: `http://${nowhere}` });
  assert.equal((await next(ws, 'close')).code, 1011);
});

test('oversized frames and too many bridges are refused', async () => {
  const ws = await open(`${wsBase}/mqtt?host=${BROKER}&port=8883`, origin());
  ws.send(new Uint8Array(300 * 1024));
  assert.equal((await next(ws, 'close')).code, 1009);

  const small = await start(
    (options) => tlsConnect({ ...options, host: '127.0.0.1', port: brokerPort, ca: cert }),
    { maxBridges: 1 },
  );
  const url = `ws://${small}/mqtt?host=${BROKER}&port=8883`;
  const first = await open(url, { origin: `http://${small}` });
  await assert.rejects(open(url, { origin: `http://${small}` }));
  first.close();
});

test('the REST relay over HTTP: mapping, body, limits', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response('{"code":200}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const res = await realFetch(`${base}/rest/euiot.roborock.com/api/v1/login?a=1&b=%20x`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', header_clientid: 'abc' },
    body: 'k=v',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { code: 200 });
  assert.equal(seen.url, 'https://euiot.roborock.com/api/v1/login?a=1&b=%20x');
  assert.equal(Buffer.from(seen.init.body).toString(), 'k=v');
  assert.deepEqual([...seen.init.headers.keys()].sort(), ['content-type', 'header_clientid']);

  globalThis.fetch = () => assert.fail('must not fetch');
  const get = (path, headers) => realFetch(`${base}${path}`, { headers });
  assert.equal((await get('/rest/evil.com/x')).status, 403);
  assert.equal((await get('/rest/')).status, 403);
  assert.equal((await get('/rest/euiot.roborock.com/x', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/rest/euiot.roborock.com/x', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await get('/nothing')).status, 404);
  assert.equal((await get('/js/app.js')).status, 404);
  const big = await realFetch(`${base}/rest/euiot.roborock.com/x`, {
    method: 'POST',
    body: 'x'.repeat(300 * 1024),
  });
  assert.equal(big.status, 413);

  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal((await get('/rest/euiot.roborock.com/x')).status, 502);
});

test('the start page is answered here, since the proxy passes directories on', async () => {
  const res = await realFetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), /<title>/);
});
