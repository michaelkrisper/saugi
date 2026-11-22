// Fitting a lite map onto a lidar map: a synthetic flat (two rooms, a wall, a door),
// seen by the lite vacuum from another start, turned by 90 degrees.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitLiteMap, liteToMm } from '../public/js/align.js';
import { FLOOR, OBSTACLE, SIZE } from '../public/js/litemap.js';

const ROOM = (16 << 3) | 7;
const SIDE_ROOM = (17 << 3) | 7;
const WALL = 1;

// Lidar map: 300 x 240 pixels of 50 mm. Floor of the flat in coarse cells (150 mm).
const inFlat = (X, Y) => (X >= 20 && X < 60 && Y >= 20 && Y < 45) || (X >= 40 && X < 55 && Y >= 45 && Y < 70);

function lidar() {
  const image = { left: 300, top: 250, width: 300, height: 240, pixels: new Uint8Array(300 * 240) };
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 300; x++) {
      const X = Math.floor(x / 3);
      const Y = Math.floor(y / 3);
      if (inFlat(X, Y)) image.pixels[y * 300 + x] = Y >= 45 ? SIDE_ROOM : ROOM;
      else if ([-1, 0, 1].some((d) => inFlat(X + d, Y) || inFlat(X, Y + d))) image.pixels[y * 300 + x] = WALL;
    }
  }
  return image;
}

// The same flat as the lite vacuum saw it: its centre field is coarse cell (45, 30),
// its frame turned so that lidar = centre + R(90) * lite.
function lite() {
  const fields = new Uint8Array(SIZE * SIZE);
  for (let v = 0; v < SIZE; v++) {
    for (let u = 0; u < SIZE; u++) {
      const [dx, dy] = [u - 101, v - 101];
      const [X, Y] = [45 - dy, 30 + dx];
      if (inFlat(X, Y)) fields[v * SIZE + u] = FLOOR;
      else if ([-1, 0, 1].some((d) => inFlat(X + d, Y) || inFlat(X, Y + d))) fields[v * SIZE + u] = OBSTACLE;
    }
  }
  return fields;
}

test('finds heading and shift', async () => {
  const fit = await fitLiteMap(lite(), lidar(), null, () => {});
  // Middle pixel of coarse cell (45, 30), 50 mm per pixel.
  assert.deepEqual(fit, { a: 90, x: (300 + 45 * 3 + 1) * 50, y: (250 + 30 * 3 + 1) * 50 });
  // The middle of the centre field is that point; one field along the lite x axis is 150 mm up.
  assert.deepEqual(liteToMm(fit, 101.5, 101.5), [fit.x, fit.y]);
  const [x, y] = liteToMm(fit, 102.5, 101.5);
  assert.ok(Math.abs(x - fit.x) < 1e-6 && Math.abs(y - fit.y - 150) < 1e-6);
});

test('gives up on a run that is too small or fits nowhere', async () => {
  const small = new Uint8Array(SIZE * SIZE);
  for (let v = 100; v < 110; v++) small.fill(FLOOR, v * SIZE + 100, v * SIZE + 110);
  assert.equal(await fitLiteMap(small, lidar(), null, () => {}), null);
  // A hall of 12 m x 1.5 m is longer than anything in the flat.
  const hall = new Uint8Array(SIZE * SIZE);
  for (let v = 100; v < 110; v++) hall.fill(FLOOR, v * SIZE + 60, v * SIZE + 140);
  assert.equal(await fitLiteMap(hall, lidar(), null, () => {}), null);
});

test("the dock's room places a run that fits in several spots", async () => {
  // 3 m x 1.5 m of floor: fits all over the flat. Its dock is at the lite map's centre.
  const fields = new Uint8Array(SIZE * SIZE);
  for (let v = 101; v < 111; v++) fields.fill(FLOOR, v * SIZE + 101, v * SIZE + 121);
  const dock = { x: 101.5 * 150, y: 101.5 * 150 };
  assert.equal(await fitLiteMap(fields, lidar(), null, () => {}), null);
  for (const room of [16, 17]) {
    const fit = await fitLiteMap(fields, lidar(), { ...dock, room }, () => {});
    const [x, y] = liteToMm(fit, 101.5, 101.5);
    const Y = (y / 50 - 250) / 3;
    assert.ok(room === 16 ? Y < 47 : Y > 43, `room ${room}: dock at ${x}, ${y}`);
  }
});
