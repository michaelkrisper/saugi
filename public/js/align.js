// Lays a lite map (litemap.js) onto the map of the lidar vacuum (map.js). The lite map
// has its own frame per run, so the fit is searched: every heading and shift is scored
// by how well floor lands on floor and obstacles on walls. Works on a 150 mm grid, the
// lite map's resolution (3 x 3 pixels of the lidar map).

import { FIELD_MM, FLOOR, OBSTACLE, SIZE } from './litemap.js';
import { isRoom } from './map.js';

const PAD = 16;
const SLACK = 15;
const CENTER = SIZE / 2;
// Below this a run fits into any larger room: about 6 m2 of floor. With the dock's
// room known, 1.5 m2 will do.
const MIN_FLOOR = 270;
const MIN_FLOOR_DOCKED = 67;
// How far from its room the dock may land, in fields: the room's edge is where it stands.
const DOCK_REACH = 2;
const MIN_COVER = 0.85;
const CANDIDATES = 48;
// Shifts kept per heading in the coarse pass, and how far apart they must lie.
const KEEP = 3;
const APART = 6;

// One 150 mm cell of the lidar map (3 x 3 pixels): 2 floor, 1 wall, 0 neither.
function cell({ width, height, pixels }, X, Y) {
  let rooms = 0;
  let walls = 0;
  for (let y = Y * 3; y < Math.min(Y * 3 + 3, height); y++) {
    for (let x = X * 3; x < Math.min(X * 3 + 3, width); x++) {
      const t = pixels[y * width + x];
      if (isRoom(t)) rooms++;
      else if ((t & 7) === 1) walls++;
    }
  }
  return rooms >= 5 ? 2 : walls ? 1 : 0;
}

// Whether the middle pixel of a cell is floor of this room (segment number).
function inRoom({ width, height, pixels }, X, Y, room) {
  const x = Math.min(X * 3 + 1, width - 1);
  const y = Math.min(Y * 3 + 1, height - 1);
  const t = pixels[y * width + x];
  return isRoom(t) && t >> 3 === room;
}

function spread(mask, w, at) {
  for (let dy = -DOCK_REACH; dy <= DOCK_REACH; dy++)
    mask.fill(1, at + dy * w - DOCK_REACH, at + dy * w + DOCK_REACH + 1);
}

// The lidar map at 150 mm with a margin: what a floor field and what an obstacle scores there.
function coarse(image, room) {
  const w = Math.ceil(image.width / 3) + 2 * PAD;
  const h = Math.ceil(image.height / 3) + 2 * PAD;
  const floor = new Int8Array(w * h).fill(-2);
  const wall = new Int8Array(w * h);
  // Where the dock may be: cells within DOCK_REACH of the room's floor.
  const dock = room === undefined ? null : new Uint8Array(w * h);
  for (let Y = 0; Y < h - 2 * PAD; Y++) {
    for (let X = 0; X < w - 2 * PAD; X++) {
      const at = (Y + PAD) * w + X + PAD;
      const kind = cell(image, X, Y);
      if (dock && inRoom(image, X, Y, room)) spread(dock, w, at);
      if (kind === 2) {
        floor[at] = 2;
        wall[at] = -1;
      } else if (kind === 1) wall[at] = 2;
    }
  }
  return { w, h, floor, wall, dock };
}

// Every `step`-th point turned by `deg` around the lite map's centre, rounded to fields.
function turn(points, deg, step) {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  const out = new Int16Array(Math.ceil(points.length / 2 / step) * 2);
  for (let i = 0, o = 0; i < points.length; i += 2 * step, o += 2) {
    out[o] = Math.round(c * points[i] - s * points[i + 1]);
    out[o + 1] = Math.round(s * points[i] + c * points[i + 1]);
  }
  return out;
}

function sum(table, w, pts, tx, ty) {
  let score = 0;
  for (let i = 0; i < pts.length; i += 2) score += table[(pts[i + 1] + ty) * w + pts[i] + tx];
  return score;
}

// Adds a shift to the best ones (best first) unless a better one lies close by.
function keep(found, shift) {
  if (found.length === KEEP && shift.score <= found[KEEP - 1].score) return;
  const near = (f) => Math.abs(f.tx - shift.tx) <= APART && Math.abs(f.ty - shift.ty) <= APART;
  const same = found.findIndex(near);
  if (same >= 0 && found[same].score >= shift.score) return;
  if (same >= 0) found.splice(same, 1);
  found.push(shift);
  found.sort((p, q) => q.score - p.score);
  found.length = Math.min(found.length, KEEP);
}

// Best shifts for one heading, best first; `dock` (the turned dock) must land near its
// room; `near` limits the search to +-3 fields around a shift.
function best(g, floor, obstacles, near, dock) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const pts of [floor, obstacles, dock ?? []]) {
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
  }
  // The lite map may stick out of the lidar map a little, never past the margin.
  let [txMin, txMax] = [PAD - SLACK - x0, g.w - 1 - PAD + SLACK - x1];
  let [tyMin, tyMax] = [PAD - SLACK - y0, g.h - 1 - PAD + SLACK - y1];
  if (near) {
    [txMin, txMax] = [Math.max(txMin, near.tx - 3), Math.min(txMax, near.tx + 3)];
    [tyMin, tyMax] = [Math.max(tyMin, near.ty - 3), Math.min(tyMax, near.ty + 3)];
  }
  // The best shifts that lie apart: a second room the run fits into stays in the race.
  const found = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (dock && !g.dock[(dock[1] + ty) * g.w + dock[0] + tx]) continue;
      const score = sum(g.floor, g.w, floor, tx, ty) + sum(g.wall, g.w, obstacles, tx, ty);
      keep(found, { score, tx, ty });
    }
  }
  return found;
}

// The fields of one kind as [x, y, x, y, ...] around the lite map's centre.
function points(fields, kind) {
  const out = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) if (fields[y * SIZE + x] === kind) out.push(x - CENTER, y - CENTER);
  }
  return out;
}

// { a, x, y }: heading in degrees and where the lite map's centre lies, in the lidar
// map's millimetres (see liteToMm). null when the run is too small or fits nowhere.
// `dock` narrows the search: { x, y } is the lite map's charger, `room` the lidar map's
// segment it stands in. `pause` lets the page breathe between headings.
export async function fitLiteMap(fields, image, dock, pause = () => new Promise((r) => setTimeout(r))) {
  const floor = points(fields, FLOOR);
  const obstacles = points(fields, OBSTACLE);
  if (floor.length / 2 < (dock ? MIN_FLOOR_DOCKED : MIN_FLOOR)) return null;
  const g = coarse(image, dock?.room);
  const at = dock && [dock.x / FIELD_MM - CENTER - 0.5, dock.y / FIELD_MM - CENTER - 0.5];
  const docked = (a) => at && turn(at, a, 1);
  // A coarse pass over all headings with a third of the points, then the most
  // promising headings again with all of them: the coarse winner alone can be wrong.
  const rough = [];
  for (let a = 0; a < 360; a += 5) {
    for (const found of best(g, turn(floor, a, 3), turn(obstacles, a, 3), null, docked(a)))
      rough.push({ ...found, a });
    await pause();
  }
  rough.sort((p, q) => q.score - p.score);
  let fit = { score: -Infinity };
  for (const start of rough.slice(0, CANDIDATES)) {
    for (let a = start.a - 4; a <= start.a + 4; a++) {
      const [found] = best(g, turn(floor, a, 1), turn(obstacles, a, 1), start, docked(a));
      if (found?.score > fit.score) fit = { ...found, a };
    }
    await pause();
  }
  if (fit.tx === undefined) return null;
  const turned = turn(floor, fit.a, 1);
  const cover = (sum(g.floor, g.w, turned, fit.tx, fit.ty) / turned.length + 1) / 2;
  if (cover < MIN_COVER) return null;
  // Field (CENTER, CENTER) lands on coarse cell (tx, ty), whose middle pixel is 3 * t + 1.
  return {
    a: (fit.a + 360) % 360,
    x: (image.left + 3 * (fit.tx - PAD) + 1) * 50,
    y: (image.top + 3 * (fit.ty - PAD) + 1) * 50,
  };
}

// A point of the lite map, in fields (a position in mm divided by FIELD_MM), in the
// lidar map's millimetres.
export function liteToMm(fit, u, v) {
  const c = Math.cos((fit.a * Math.PI) / 180);
  const s = Math.sin((fit.a * Math.PI) / 180);
  const dx = (u - CENTER - 0.5) * FIELD_MM;
  const dy = (v - CENTER - 0.5) * FIELD_MM;
  return [fit.x + c * dx - s * dy, fit.y + s * dx + c * dy];
}
