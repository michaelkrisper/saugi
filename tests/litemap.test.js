// The lite map format, built by hand here as the Xiaomi Home plugin reads it:
// header, charger/robot blocks, LZ4 chunks of a 101 x 101 grid with four 2-bit fields
// per byte.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOOR, OBSTACLE, parseLiteMap, SIZE, UNKNOWN } from '../public/js/litemap.js';

const u16 = (n) => [n & 255, n >> 8];
const i32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const block = (type, payload) => [...u16(type), ...u16(payload.length + 4), ...payload];

// 10201 grid bytes as two LZ4 chunks: literals [v0, v1], then matches that repeat them.
function mapBlock(v0, v1) {
  const long = (n) => [...Array(Math.floor(n / 255)).fill(255), n % 255];
  // literals 2, match length 15 + ext + 4 at distance 2
  const first = [0x2f, v0, v1, 2, 0, ...long(5000 - 2 - 19)];
  const second = [0x0f, 2, 0, ...long(5201 - 19)];
  const lengths = new Array(50).fill(0);
  lengths[0] = first.length;
  lengths[1] = second.length;
  return block(3, [1, 1, 2, ...lengths, 0, 0, ...first, ...second]);
}

test('parses positions and the grid', () => {
  // 0x1b: fields 3 (floor), 2 (obstacle), 1 (floor), 0 (unknown)
  const bytes = Uint8Array.from([
    ...'RRSA'.split('').map((c) => c.charCodeAt(0)),
    ...new Array(14).fill(0),
    ...block(1, [...i32(0x7fffffff), ...i32(0x7fffffff)]),
    ...block(2, [...i32(11863), ...i32(11272)]),
    ...block(4, [106, 0]),
    ...mapBlock(0x1b, 0x00),
  ]);
  const map = parseLiteMap(bytes);
  assert.equal(map.charger, null);
  assert.deepEqual(map.robot, { x: 11863, y: 11272 });
  assert.equal(map.fields.length, SIZE * SIZE);
  // First grid byte: bits 0-1 top left, 4-5 top right, 2-3 bottom left, 6-7 bottom right.
  assert.deepEqual(
    [map.fields[0], map.fields[1], map.fields[SIZE], map.fields[SIZE + 1]],
    [FLOOR, FLOOR, OBSTACLE, UNKNOWN],
  );
  assert.equal(map.fields[2], UNKNOWN);
  // The pattern repeats through both chunks: the last grid byte (index 10200, even) is 0x1b.
  assert.equal(map.fields[200 * SIZE + 200], FLOOR);
  assert.equal(map.fields.filter((f) => f === OBSTACLE).length, 5101);
});

test('refuses other data', () => {
  assert.throws(() => parseLiteMap(Uint8Array.from([0x72, 0x72, 0, 0, 0])), /lite map/);
});
