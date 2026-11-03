// Edge cases of the "1.0" codec and the crypto helpers it builds on.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aesEcbDecrypt,
  aesEcbEncrypt,
  base64,
  concat,
  hmacSha256Base64,
  unbase64,
  utf8,
} from '../public/js/crypto.js';
import { buildRpc, decodeMessage, encodeMessage, parseDps, RPC_REQUEST } from '../public/js/protocol.js';

const KEY = 'abcdEFGH12345678';
const msg = (payload) => ({
  seq: 1,
  random: 2,
  timestamp: 0x6543210f,
  protocol: 102,
  payload: utf8(payload),
});

test('AES-ECB applies PKCS#7 padding at every length around the block size', async () => {
  const key = utf8('0123456789abcdef');
  for (const n of [0, 1, 15, 16, 17, 31, 32, 33]) {
    const plain = Uint8Array.from({ length: n }, (_, i) => i * 7);
    const cipher = await aesEcbEncrypt(plain, key);
    assert.equal(cipher.length, (Math.floor(n / 16) + 1) * 16, `length ${n}`);
    assert.deepEqual(await aesEcbDecrypt(cipher, key), plain);
  }
});

test('identical plaintext blocks give identical cipher blocks (ECB, not CBC)', async () => {
  const c = await aesEcbEncrypt(new Uint8Array(32), utf8('0123456789abcdef'));
  assert.deepEqual(c.subarray(0, 16), c.subarray(16, 32));
});

test('base64, concat and HMAC-SHA256 helpers', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(unbase64(base64(bytes)), bytes);
  assert.deepEqual(concat(utf8('ab'), new Uint8Array(0), utf8('c')), utf8('abc'));
  // RFC 4231, test case 2
  assert.equal(
    await hmacSha256Base64('Jefe', 'what do ya want for nothing?'),
    'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=',
  );
});

test('decodeMessage rejects a corrupted checksum and a foreign version', async () => {
  const bytes = await encodeMessage(msg('{"dps":{}}'), KEY);
  const bad = bytes.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decodeMessage(bad, KEY), /checksum mismatch/);
  const v2 = bytes.slice();
  v2.set(utf8('A01'));
  await assert.rejects(decodeMessage(v2, KEY), /unsupported protocol version A01/);
});

test('decodeMessage accepts a frame without trailing CRC and works on subarrays', async () => {
  const bytes = await encodeMessage(msg('{"dps":{"121":8}}'), KEY);
  const framed = concat(new Uint8Array(5), bytes, new Uint8Array(3)).subarray(5, 5 + bytes.length - 4);
  const back = await decodeMessage(framed, KEY);
  assert.equal(back.timestamp, 0x6543210f);
  assert.deepEqual(parseDps(back.payload), { 121: 8 });
});

test('a wrong local key never yields the original payload', async () => {
  const bytes = await encodeMessage(msg('{"dps":{}}'), KEY);
  // Garbage may still carry valid padding, so either outcome is fine as long as it is not the plaintext.
  const out = await decodeMessage(bytes, 'wrongkey12345678').then(
    (m) => m.payload,
    () => null,
  );
  assert.notDeepEqual(out, utf8('{"dps":{}}'));
});

test('buildRpc without security omits the security block and stays in range', () => {
  const { id, message } = buildRpc('app_start', [1]);
  const outer = JSON.parse(new TextDecoder().decode(message.payload));
  const inner = JSON.parse(outer.dps[101]);
  assert.deepEqual(inner, { id, method: 'app_start', params: [1] });
  assert.equal(outer.t, message.timestamp);
  assert.equal(message.protocol, RPC_REQUEST);
  assert.ok(id >= 10000 && id < 32767);
});

test('parseDps returns an empty object when there are no datapoints', () => {
  assert.deepEqual(parseDps(utf8('{"t":1}')), {});
});
