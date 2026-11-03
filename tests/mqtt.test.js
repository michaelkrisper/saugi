// MQTT 3.1.1 framing of the minimal client, against a fake WebSocket that
// records what is sent and lets the test play the broker.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { MqttClient } from '../public/js/mqtt.js';

class FakeSocket {
  static OPEN = 1;
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }
  send(bytes) {
    this.sent.push(Array.from(bytes));
  }
  receive(...bytes) {
    this.onmessage({ data: new Uint8Array(bytes.flat()).buffer });
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ascii = (s) => Array.from(Buffer.from(s));
const str = (s) => [s.length >> 8, s.length & 0xff, ...ascii(s)];
const CONNACK_OK = [0x20, 2, 0, 0];

let realWebSocket;
let client;
beforeEach(() => {
  realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  client = new MqttClient('ws://relay/mqtt', {
    clientId: 'cid',
    username: 'user',
    password: 'pw',
    keepalive: 30,
  });
});
afterEach(() => {
  client.close();
  globalThis.WebSocket = realWebSocket;
});

async function connected() {
  const done = client.connect();
  await tick();
  FakeSocket.last.receive(CONNACK_OK);
  await done;
  return FakeSocket.last;
}

test('CONNECT carries protocol level 4, credentials and keepalive', async () => {
  const ws = await connected();
  const body = [...str('MQTT'), 4, 0xc2, 0, 30, ...str('cid'), ...str('user'), ...str('pw')];
  assert.deepEqual(ws.sent[0], [0x10, body.length, ...body]);
  assert.equal(client.connected, true);
});

test('a refused CONNACK rejects connect with the return code', async () => {
  const done = client.connect();
  await tick();
  FakeSocket.last.receive([0x20, 2, 0, 5]);
  await assert.rejects(done, /code 5/);
});

test('closing the socket rejects pending requests', async () => {
  const done = client.connect();
  await tick();
  FakeSocket.last.close(1006);
  await assert.rejects(done, /closed \(1006\)/);
});

test('SUBSCRIBE uses QoS 1 flags and resolves on SUBACK', async () => {
  const ws = await connected();
  const sub = client.subscribe('rr/m/o/a');
  const id = client.packetId;
  assert.deepEqual(ws.sent[1], [0x82, 2 + 2 + 8 + 1, id >> 8, id & 0xff, ...str('rr/m/o/a'), 1]);
  ws.receive([0x90, 3, id >> 8, id & 0xff, 1]);
  await sub;
});

test('a SUBACK failure code rejects the subscription', async () => {
  const ws = await connected();
  const sub = client.subscribe('t');
  const id = client.packetId;
  ws.receive([0x90, 3, id >> 8, id & 0xff, 0x80]);
  await assert.rejects(sub, /subscribe refused/);
});

test('PUBLISH QoS 1 resolves on the matching PUBACK; QoS 0 has no packet id', async () => {
  const ws = await connected();
  const pub = client.publish('t', new Uint8Array([9, 8]));
  const id = client.packetId;
  assert.deepEqual(ws.sent[1], [0x32, 3 + 2 + 2, ...str('t'), id >> 8, id & 0xff, 9, 8]);
  ws.receive([0x40, 2, id >> 8, id & 0xff]);
  await pub;
  await client.publish('t', new Uint8Array([7]), 0);
  assert.deepEqual(ws.sent[2], [0x30, 4, ...str('t'), 7]);
});

test('packet ids wrap from 65535 to 1, never 0', async () => {
  await connected();
  client.packetId = 0xfffe;
  client.publish('t', new Uint8Array(0), 1).catch(() => {});
  assert.equal(client.packetId, 0xffff);
  client.publish('t', new Uint8Array(0), 1).catch(() => {});
  assert.equal(client.packetId, 1);
});

test('incoming QoS 1 PUBLISH is delivered and acknowledged', async () => {
  const ws = await connected();
  const got = [];
  client.onmessage = (topic, payload) => got.push([topic, Array.from(payload)]);
  ws.receive([0x32, 2 + 3 + 2 + 2, ...str('a/b'), 0x12, 0x34, 0xde, 0xad]);
  assert.deepEqual(got, [['a/b', [0xde, 0xad]]]);
  assert.deepEqual(ws.sent.at(-1), [0x40, 2, 0x12, 0x34]);
});

test('packets split across frames and multi-byte lengths are reassembled', async () => {
  const ws = await connected();
  const got = [];
  client.onmessage = (topic, payload) => got.push([topic, payload.length]);
  const payload = new Array(300).fill(0x55);
  const body = [...str('x'), ...payload];
  // 303 bytes -> remaining length 0xaf 0x02.
  const frame = [0x30, 0xaf, 0x02, ...body, 0x30, 4, ...str('y'), 1];
  ws.receive(frame.slice(0, 2));
  ws.receive(frame.slice(2, 100));
  assert.equal(got.length, 0);
  ws.receive(frame.slice(100));
  assert.deepEqual(got, [
    ['x', 300],
    ['y', 1],
  ]);
});
