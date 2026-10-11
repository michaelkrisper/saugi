// Roborock v1 map format (port of vacuum-map-parser-roborock): a header and a
// chain of blocks. Coordinates in blocks are millimetres; one image pixel is 50 mm.

const CHARGER = 1;
const IMAGE = 2;
const PATH = 3;
const ROBOT = 8;
// Block type -> [field, coordinates per shape]: areas are 4 corners, walls 2 ends.
const SHAPES = { 9: ['noGo', 8], 10: ['walls', 4], 12: ['noMop', 8] };

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function position(data, len) {
  const p = { x: u32(data, 0), y: u32(data, 4), a: 0 };
  if (len > 8) {
    let a = u32(data, 8);
    if (a > 0xff) a = (a & 0xff) - 256;
    p.a = a;
  }
  return p;
}

function shapes(raw, pos, data, coords) {
  const count = u16(raw, pos + 8);
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: coords }, (_, j) => u16(data, (i * coords + j) * 2)),
  );
}

export function parseMap(raw) {
  const map = { path: [], robot: null, charger: null, image: null, noGo: [], walls: [], noMop: [] };
  let pos = u16(raw, 2);
  while (pos < raw.length) {
    const type = u16(raw, pos);
    const headerLen = u16(raw, pos + 2);
    const dataLen = u32(raw, pos + 4);
    const start = pos + headerLen;
    const data = raw.subarray(start, start + dataLen);
    if (type === CHARGER) map.charger = position(data, dataLen);
    else if (type === ROBOT) map.robot = position(data, dataLen);
    else if (SHAPES[type]) map[SHAPES[type][0]] = shapes(raw, pos, data, SHAPES[type][1]);
    else if (type === PATH) {
      const pts = new Uint16Array(dataLen / 2);
      for (let i = 0; i < pts.length; i++) pts[i] = u16(raw, pos + 0x14 + i * 2);
      map.path = pts;
    } else if (type === IMAGE) {
      map.image = {
        top: i32(raw, start - 16),
        left: i32(raw, start - 12),
        height: i32(raw, start - 8),
        width: i32(raw, start - 4),
        pixels: data,
      };
    }
    pos = start + dataLen;
  }
  return map;
}

// Millimetres -> image pixel (y axis flipped, origin top-left).
export function toPixel(img, x, y) {
  return [x / 50 - img.left, img.height - (y / 50 - img.top) - 1];
}

const ROOM_COLORS = [
  '#3b6ea8',
  '#4f8a6b',
  '#a8743b',
  '#7a5aa8',
  '#a84f6a',
  '#3b8f9a',
  '#8f8a3b',
  '#5a6aa8',
  '#6a9a4f',
  '#a85a4f',
  '#4f7aa8',
  '#9a4f8f',
  '#4f9a8a',
  '#a8914f',
  '#6a5aa8',
  '#8a4f4f',
];

function rgb(hexColor) {
  const n = Number.parseInt(hexColor.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

const WALL = rgb('#cfd6de');
const FLOOR = rgb('#2c333d');
const GREY = rgb('#7d8590');
const ROOM_RGB = ROOM_COLORS.map(rgb);

const isRoom = (t) => t !== 0xff && t !== 7 && (t & 7) === 7;

function pixelColor(t) {
  if (t === 1) return WALL;
  if (t === 0xff || t === 7) return FLOOR;
  if ((t & 7) === 7) return ROOM_RGB[(t >> 3) % ROOM_RGB.length];
  return (t & 7) === 1 ? WALL : GREY;
}

// Bounding box of everything that is not "outside" (0).
function bounds({ width: w, height: h, pixels }) {
  const b = { x0: w, y0: h, x1: -1, y1: -1 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[y * w + x] === 0) continue;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
    }
  }
  return b.x1 < 0 ? null : b;
}

// Builds a cropped bitmap of the floor plan plus room centroids. Cached per
// image so live updates only redraw the path and robot.
export function rasterize(img) {
  const b = bounds(img);
  if (!b) return null;
  const { width: w, pixels } = img;
  const cw = b.x1 - b.x0 + 1;
  const ch = b.y1 - b.y0 + 1;
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  const rooms = new Map();
  for (let y = b.y0; y <= b.y1; y++) {
    const outY = b.y1 - y; // flip: raw row 0 is the bottom
    for (let x = b.x0; x <= b.x1; x++) {
      const t = pixels[y * w + x];
      if (t === 0) continue;
      const c = pixelColor(t);
      rgba.set([c[0], c[1], c[2], 255], (outY * cw + (x - b.x0)) * 4);
      if (isRoom(t)) {
        const r = rooms.get(t >> 3) ?? { sx: 0, sy: 0, n: 0 };
        r.sx += x - b.x0;
        r.sy += outY;
        r.n++;
        rooms.set(t >> 3, r);
      }
    }
  }
  const centers = [...rooms].map(([id, r]) => ({ id, x: r.sx / r.n, y: r.sy / r.n }));
  // Crop origin in full-image pixel coordinates (after the flip).
  return { rgba, width: cw, height: ch, ox: b.x0, oy: img.height - 1 - b.y1, centers };
}
