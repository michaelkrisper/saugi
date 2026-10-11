// Reference values in fixtures/vectors.json come from python-roborock 7.12
// (the library Home Assistant uses); s6.bin is a map from its test data.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hawk } from '../public/js/api.js';
import { aesEcbDecrypt, aesEcbEncrypt, crc32, hex, md5hex, utf8 } from '../public/js/crypto.js';
import { parseMap, rasterize, toPixel } from '../public/js/map.js';
import {
  buildRpc,
  createSecurity,
  decodeMapResponse,
  decodeMessage,
  encodeMessage,
  encodeTimestamp,
  parseDps,
} from '../public/js/protocol.js';

const V = JSON.parse(readFileSync(new URL('fixtures/vectors.json', import.meta.url)));
const RAW_MAP = new Uint8Array(readFileSync(new URL('fixtures/s6.bin', import.meta.url)));
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

test('md5 matches hashlib', () => {
  for (const [input, digest] of Object.entries(V.md5)) assert.equal(md5hex(input), digest, input);
});

test('crc32 matches zlib', () => {
  for (const [input, crc] of Object.entries(V.crc32)) assert.equal(crc32(utf8(input)), crc);
});

test('AES-ECB round-trips against pycryptodome', async () => {
  const key = fromHex(V.ecb_key);
  for (const { plain, cipher } of V.ecb) {
    assert.equal(hex(await aesEcbEncrypt(fromHex(plain), key)), cipher);
    assert.equal(hex(await aesEcbDecrypt(fromHex(cipher), key)), plain);
  }
});

test('timestamp encoding', () => {
  for (const [ts, enc] of Object.entries(V.encode_timestamp)) assert.equal(encodeTimestamp(Number(ts)), enc);
});

test('message encode is byte-identical and decodes', async () => {
  const m = V.message;
  const msg = {
    seq: m.seq,
    random: m.random,
    timestamp: m.timestamp,
    protocol: m.protocol,
    payload: utf8(m.payload),
  };
  assert.equal(hex(await encodeMessage(msg, m.local_key)), m.bytes);
  const decoded = await decodeMessage(fromHex(m.bytes), m.local_key);
  assert.equal(decoded.seq, m.seq);
  assert.equal(decoded.protocol, 102);
  assert.deepEqual(JSON.parse(parseDps(decoded.payload)[102]).result, [{ state: 8, battery: 100 }]);
});

test('rpc request round-trips through the codec', async () => {
  const security = createSecurity('kkey');
  const { id, message } = buildRpc('get_status', null, security);
  const back = await decodeMessage(await encodeMessage(message, 'abcdEFGH12345678'), 'abcdEFGH12345678');
  const inner = JSON.parse(parseDps(back.payload)[101]);
  assert.equal(inner.id, id);
  assert.equal(inner.method, 'get_status');
  assert.deepEqual(inner.params, []);
  assert.equal(inner.security.endpoint, V.endpoint.endpoint);
  assert.equal(inner.security.nonce, hex(security.nonce));
});

test('map response decrypts and inflates', async () => {
  const r = V.map_response;
  const res = await decodeMapResponse(fromHex(r.payload), { endpoint: r.endpoint, nonce: fromHex(r.nonce) });
  assert.equal(res.requestId, r.request_id);
  assert.deepEqual(res.data, RAW_MAP);
  assert.equal(
    await decodeMapResponse(fromHex(r.payload), { endpoint: 'other', nonce: fromHex(r.nonce) }),
    null,
  );
});

test('map parses like vacuum-map-parser-roborock', () => {
  const m = parseMap(RAW_MAP);
  const e = V.map;
  assert.deepEqual(
    [m.image.top, m.image.left, m.image.width, m.image.height],
    [e.top, e.left, e.width, e.height],
  );
  assert.deepEqual([m.robot.x, m.robot.y, m.robot.a], e.robot);
  assert.deepEqual([m.charger.x, m.charger.y], e.charger);
  assert.equal(m.path.length / 2, e.path_len);
  assert.deepEqual([m.path[0], m.path[1]], e.path_first);
  assert.deepEqual([m.path.at(-2), m.path.at(-1)], e.path_last);
  const [px, py] = toPixel(m.image, m.robot.x, m.robot.y);
  assert.ok(Math.abs(px - e.robot_px[0]) < 1e-9 && Math.abs(py - e.robot_px[1]) < 1e-9);
  const r = rasterize(m.image);
  assert.deepEqual(
    r.centers.map((c) => c.id).sort((a, b) => a - b),
    e.rooms,
  );
  assert.ok(r.width < m.image.width && r.height < m.image.height, 'cropped to the floor plan');
});

test('hawk header matches python', async () => {
  const h = V.hawk;
  assert.equal(await hawk(h.rriot, h.path, 1700000000, 'NONCE123'), h.auth);
});
