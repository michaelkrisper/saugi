// Map of a Roborock E4/E5 ("sapphire lite", no lidar): the vacuum uploads one after
// each cleaning. Format "RRSA" as read by the Xiaomi Home plugin of
// roborock.vacuum.a01 (Parser/MapParser): an 18-byte header, then blocks of
// [type u16, length u16 including these four bytes]. The map block holds a
// 101 x 101 grid, LZ4-compressed in up to 50 chunks; each byte is four 2-bit
// fields, so the grid is really 202 x 202 fields of 15 cm.

export const SIZE = 202;
// Positions are in millimetres from the grid's corner.
export const FIELD_MM = 150;
export const UNKNOWN = 0;
export const FLOOR = 1;
export const OBSTACLE = 2;

const CELLS = 101;
const NONE = 0x7fffffff;

// One LZ4 block (no frame), appended to dst at `at`; returns the new end.
function lz4Block(src, from, to, dst, at) {
  let i = from;
  while (i < to) {
    const token = src[i++];
    let literals = token >> 4;
    if (literals === 15) {
      let b;
      do {
        b = src[i++];
        literals += b;
      } while (b === 255);
    }
    for (; literals > 0; literals--) dst[at++] = src[i++];
    if (i >= to) break;
    const distance = src[i] | (src[i + 1] << 8);
    i += 2;
    if (!distance || distance > at) throw new Error('Corrupt map data');
    let length = token & 15;
    if (length === 15) {
      let b;
      do {
        b = src[i++];
        length += b;
      } while (b === 255);
    }
    for (length += 4; length > 0; length--, at++) dst[at] = dst[at - distance];
  }
  return at;
}

const field = (v) => (v === 0 ? UNKNOWN : v === 1 || v === 3 ? FLOOR : OBSTACLE);

function grid(bytes, offset) {
  const chunks = bytes[offset + 2];
  if (chunks > 50) return null;
  const raw = new Uint8Array(CELLS * CELLS + 64);
  let src = offset + 55;
  let end = 0;
  for (let c = 0; c < chunks; c++) {
    const length = bytes[offset + 3 + c];
    end = lz4Block(bytes, src, src + length, raw, end);
    src += length;
  }
  const fields = new Uint8Array(SIZE * SIZE);
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      const v = raw[row * CELLS + col];
      const at = row * 2 * SIZE + col * 2;
      fields[at] = field(v & 3);
      fields[at + 1] = field((v >> 4) & 3);
      fields[at + SIZE] = field((v >> 2) & 3);
      fields[at + SIZE + 1] = field(v >> 6);
    }
  }
  return fields;
}

// { fields: Uint8Array(SIZE * SIZE) | null, robot: { x, y } | null, charger: { x, y } | null }
export function parseLiteMap(bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RRSA') throw new Error('Not a lite map');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const point = (at) => {
    const x = view.getInt32(at, true);
    const y = view.getInt32(at + 4, true);
    return x === NONE || y === NONE ? null : { x, y };
  };
  const map = { fields: null, robot: null, charger: null };
  for (let at = 18; at + 4 <= bytes.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (length < 4) break;
    if (type === 1) map.charger = point(at + 4);
    else if (type === 2) map.robot = point(at + 4);
    else if (type === 3) map.fields = grid(bytes, at + 4);
    at += length;
  }
  return map;
}
