// Minimal MQTT 3.1.1 client over a WebSocket byte stream (QoS 0/1, one
// subscription is all we need). The WebSocket is bridged to TLS port 8883 by
// functions/mqtt.js because the Roborock broker has no WebSocket listener.

import { concat, utf8 } from './crypto.js';

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return new Uint8Array(out);
}

function str(s) {
  const b = utf8(s);
  return concat(new Uint8Array([b.length >> 8, b.length & 0xff]), b);
}

const packet = (type, flags, body) =>
  concat(new Uint8Array([(type << 4) | flags]), varint(body.length), body);
const u16 = (n) => new Uint8Array([n >> 8, n & 0xff]);

export class MqttClient {
  constructor(url, { clientId, username, password, keepalive = 60 }) {
    this.url = url;
    this.opts = { clientId, username, password, keepalive };
    this.buf = new Uint8Array(0);
    this.packetId = 1;
    this.pending = new Map();
    this.onmessage = null;
    this.onclose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.pending.set('connack', { resolve, reject });
      ws.onopen = () => {
        const { clientId, username, password, keepalive } = this.opts;
        const body = concat(
          str('MQTT'),
          new Uint8Array([4, 0xc2]), // level 4, flags: username + password + clean session
          u16(keepalive),
          str(clientId),
          str(username),
          str(password),
        );
        ws.send(packet(CONNECT, 0, body));
      };
      ws.onmessage = (e) => this.#feed(new Uint8Array(e.data));
      ws.onerror = () => {};
      ws.onclose = (e) => {
        clearInterval(this.pinger);
        const err = new Error(`connection closed (${e.code})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.onclose?.(err);
      };
      this.pinger = setInterval(
        () => this.#send(packet(PINGREQ, 0, new Uint8Array(0))),
        (this.opts.keepalive * 1000) / 2,
      );
    });
  }

  close() {
    this.onclose = null;
    this.ws?.close();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  subscribe(topic, qos = 1) {
    const id = this.#nextId();
    this.#send(packet(SUBSCRIBE, 2, concat(u16(id), str(topic), new Uint8Array([qos]))));
    return this.#await(id);
  }

  publish(topic, payload, qos = 1) {
    if (qos === 0) {
      this.#send(packet(PUBLISH, 0, concat(str(topic), payload)));
      return Promise.resolve();
    }
    const id = this.#nextId();
    this.#send(packet(PUBLISH, qos << 1, concat(str(topic), u16(id), payload)));
    return this.#await(id);
  }

  #nextId() {
    this.packetId = (this.packetId % 0xffff) + 1;
    return this.packetId;
  }

  #await(id) {
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  #send(bytes) {
    if (this.connected) this.ws.send(bytes);
  }

  #feed(chunk) {
    this.buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    for (;;) {
      let len = 0;
      let mult = 1;
      let i = 1;
      for (;;) {
        if (i >= this.buf.length) return;
        const b = this.buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if (!(b & 0x80)) break;
      }
      if (this.buf.length < i + len) return;
      this.#handle(this.buf[0], this.buf.subarray(i, i + len));
      this.buf = this.buf.subarray(i + len);
    }
  }

  #handle(header, body) {
    const type = header >> 4;
    const id = body.length >= 2 ? (body[0] << 8) | body[1] : 0;
    switch (type) {
      case CONNACK: {
        const p = this.pending.get('connack');
        this.pending.delete('connack');
        if (body[1] === 0) p?.resolve();
        else p?.reject(new Error(`MQTT connect refused (code ${body[1]})`));
        break;
      }
      case PUBLISH: {
        const qos = (header >> 1) & 3;
        const tlen = (body[0] << 8) | body[1];
        const topic = new TextDecoder().decode(body.subarray(2, 2 + tlen));
        let off = 2 + tlen;
        if (qos > 0) {
          const pid = (body[off] << 8) | body[off + 1];
          off += 2;
          this.#send(packet(PUBACK, 0, u16(pid)));
        }
        this.onmessage?.(topic, body.slice(off));
        break;
      }
      case PUBACK:
      case SUBACK: {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (type === SUBACK && body[2] === 0x80) p?.reject(new Error('subscribe refused'));
        else p?.resolve();
        break;
      }
      case PINGRESP:
        break;
    }
  }
}
