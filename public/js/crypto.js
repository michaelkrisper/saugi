// Crypto primitives for the Roborock protocol. WebCrypto has no MD5 and no
// AES-ECB, so MD5 is implemented here and ECB is emulated on top of AES-CBC.

const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unbase64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// --- MD5 (RFC 1321) ---

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(input) {
  const data = typeof input === 'string' ? utf8(input) : input;
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + m[g]) >>> 0;
      const s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  for (const [i, v] of [a0, b0, c0, d0].entries()) odv.setUint32(i * 4, v, true);
  return out;
}

export const md5hex = (input) => hex(md5(input));

// --- CRC32 (zlib polynomial) ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- AES ---

const ZERO_IV = new Uint8Array(16);
const importAes = (key) => crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);

function pkcs7(data) {
  const n = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + n);
  out.set(data);
  out.fill(n, data.length);
  return out;
}

// ECB = every block encrypted on its own, i.e. CBC with a zero IV per block.
export async function aesEcbEncrypt(plain, keyBytes) {
  const key = await importAes(keyBytes);
  const padded = pkcs7(plain);
  const blocks = [];
  for (let i = 0; i < padded.length; i += 16) {
    blocks.push(crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, padded.subarray(i, i + 16)));
  }
  return concat(...(await Promise.all(blocks)).map((b) => new Uint8Array(b, 0, 16)));
}

// CBC-decrypting ECB ciphertext yields D(C_i) ^ C_{i-1}; XOR the previous block
// back in. A crafted trailing block whose plaintext is a full PKCS#7 pad block
// keeps WebCrypto's padding check happy; the real padding is stripped after.
export async function aesEcbDecrypt(cipher, keyBytes) {
  if (!cipher.length) return cipher;
  const key = await importAes(keyBytes);
  const last = cipher.subarray(cipher.length - 16);
  const pad = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, new Uint8Array(0)),
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, concat(cipher, pad.subarray(0, 16))),
  );
  for (let i = plain.length - 1; i >= 16; i--) plain[i] ^= cipher[i - 16];
  return plain.subarray(0, plain.length - plain[plain.length - 1]);
}

export async function aesCbcDecrypt(cipher, keyBytes) {
  const key = await importAes(keyBytes);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, cipher));
}

export async function hmacSha256Base64(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', utf8(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(msg))));
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
