// One vacuum over the Roborock MQTT cloud: RPC calls with request-id matching,
// status pushes and map blobs (protocol 301).

import { md5hex } from './crypto.js';
import { MqttClient } from './mqtt.js';
import {
  buildRpc,
  createSecurity,
  decodeMapResponse,
  decodeMessage,
  encodeMessage,
  MAP_RESPONSE,
  parseDps,
  RPC_RESPONSE,
} from './protocol.js';

const TIMEOUT_MS = 10000;

export class Robot {
  constructor(rriot, device) {
    this.rriot = rriot;
    this.device = device;
    this.security = createSecurity(rriot.k);
    this.pending = new Map();
    this.ondps = null;
    this.onclose = null;
  }

  async connect() {
    const { u, s, k, r } = this.rriot;
    const broker = new URL(r.m.replace(/^ssl:/, 'https:'));
    const user = md5hex(`${u}:${k}`).slice(2, 10);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/mqtt?host=${broker.hostname}&port=${broker.port || 8883}`;
    this.mqtt = new MqttClient(url, {
      clientId: user + md5hex(crypto.getRandomValues(new Uint8Array(8))).slice(0, 8),
      username: user,
      password: md5hex(`${s}:${k}`).slice(16),
    });
    this.mqtt.onmessage = (_topic, payload) => this.#onMessage(payload).catch((e) => console.warn(e));
    this.mqtt.onclose = (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.onclose?.(err);
    };
    await this.mqtt.connect();
    await this.mqtt.subscribe(`rr/m/o/${u}/${user}/${this.device.duid}`);
    this.topic = `rr/m/i/${u}/${user}/${this.device.duid}`;
  }

  close() {
    this.mqtt?.close();
  }

  get connected() {
    return this.mqtt?.connected ?? false;
  }

  async rpc(method, params) {
    const { id, message } = buildRpc(method, params, this.security);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The vacuum is not responding'));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        map: method === 'get_map_v1',
      });
    });
    await this.mqtt.publish(this.topic, await encodeMessage(message, this.device.localKey));
    return result;
  }

  async status() {
    const [s] = await this.rpc('get_status');
    return s;
  }

  map() {
    return this.rpc('get_map_v1');
  }

  async #onMessage(raw) {
    const msg = await decodeMessage(raw, this.device.localKey);
    if (msg.protocol === MAP_RESPONSE) {
      const res = await decodeMapResponse(msg.payload, this.security);
      const p = res && this.pending.get(res.requestId);
      if (p) {
        this.pending.delete(res.requestId);
        p.resolve(res.data);
      }
      return;
    }
    if (msg.protocol !== RPC_RESPONSE || !msg.payload) return;
    const dps = parseDps(msg.payload);
    if (dps[102]) {
      const res = JSON.parse(dps[102]);
      const p = this.pending.get(res.id);
      // get_map_v1 is acknowledged with ["ok"]; the map itself follows as 301.
      if (!p || (p.map && !res.error)) return;
      this.pending.delete(res.id);
      if (res.error) p.reject(new Error(res.error.message ?? JSON.stringify(res.error)));
      else p.resolve(res.result);
    } else {
      this.ondps?.(dps);
    }
  }
}
