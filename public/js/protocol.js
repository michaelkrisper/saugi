// Roborock "1.0" message framing as used over MQTT:
// version(3) seq(4) random(4) timestamp(4) protocol(2) len(2) payload crc32(4), big endian.
// The payload is AES-ECB encrypted with md5(encodeTimestamp(ts) + localKey + SALT).

import { aesCbcDecrypt, aesEcbDecrypt, aesEcbEncrypt, concat, crc32, gunzip, md5, utf8 } from './crypto.js';

const SALT = 'TXdfu$jyZ#TZHsg4';
export const RPC_REQUEST = 101;
export const RPC_RESPONSE = 102;
export const MAP_RESPONSE = 301;

export function encodeTimestamp(ts) {
  const h = ts.toString(16).padStart(8, '0');
  return [5, 6, 3, 7, 1, 2, 0, 4].map((i) => h[i]).join('');
}

const messageKey = (ts, localKey) => md5(encodeTimestamp(ts) + localKey + SALT);

export async function encodeMessage({ seq, random, timestamp, protocol, payload }, localKey) {
  const enc = await aesEcbEncrypt(payload, messageKey(timestamp, localKey));
  const head = new Uint8Array(19);
  const dv = new DataView(head.buffer);
  head.set(utf8('1.0'));
  dv.setUint32(3, seq);
  dv.setUint32(7, random);
  dv.setUint32(11, timestamp);
  dv.setUint16(15, protocol);
  dv.setUint16(17, enc.length);
  const body = concat(head, enc);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return concat(body, crc);
}

export async function decodeMessage(buf, localKey) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = String.fromCharCode(buf[0], buf[1], buf[2]);
  if (version !== '1.0') throw new Error(`unsupported protocol version ${version}`);
  const msg = {
    seq: dv.getUint32(3),
    random: dv.getUint32(7),
    timestamp: dv.getUint32(11),
    protocol: dv.getUint16(15),
  };
  const len = dv.getUint16(17);
  if (buf.length >= 23 + len && dv.getUint32(19 + len) !== crc32(buf.subarray(0, 19 + len))) {
    throw new Error('checksum mismatch');
  }
  msg.payload = len
    ? await aesEcbDecrypt(buf.subarray(19, 19 + len), messageKey(msg.timestamp, localKey))
    : null;
  return msg;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));

// The endpoint tells map responses for this client apart from other clients
// (e.g. the official app); the nonce is the AES key for the map body.
export function createSecurity(rriotK) {
  return {
    endpoint: btoa(String.fromCharCode(...md5(rriotK).subarray(8, 14))),
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  };
}

export function buildRpc(method, params, security) {
  const id = randInt(10000, 32767);
  const timestamp = nowSeconds();
  const inner = { id, method, params: params ?? [] };
  if (security) {
    inner.security = {
      endpoint: security.endpoint,
      nonce: Array.from(security.nonce, (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  }
  const payload = utf8(JSON.stringify({ dps: { 101: JSON.stringify(inner) }, t: timestamp }));
  return {
    id,
    message: {
      seq: randInt(100000, 999999),
      random: randInt(10000, 99999),
      timestamp,
      protocol: RPC_REQUEST,
      payload,
    },
  };
}

// Returns the datapoints of an RPC_RESPONSE / push message as {code: value}.
export function parseDps(payload) {
  const obj = JSON.parse(new TextDecoder().decode(payload));
  return obj.dps ?? {};
}

export async function decodeMapResponse(payload, security) {
  const endpoint = new TextDecoder().decode(payload.subarray(0, 8));
  if (!endpoint.startsWith(security.endpoint)) return null;
  const requestId = payload[16] | (payload[17] << 8);
  const decrypted = await aesCbcDecrypt(payload.subarray(24), security.nonce);
  return { requestId, data: await gunzip(decrypted) };
}
