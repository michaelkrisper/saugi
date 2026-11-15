// WebSocket <-> TLS bridge to the Roborock MQTT broker. Browsers cannot open raw
// TCP and the broker only listens on 8883, so this passes bytes through
// unchanged. MQTT credentials and the AES-encrypted payloads stay end-to-end
// between browser and broker apart from TLS termination here.

import { connect as tlsConnect } from 'node:tls';
import { WebSocketServer } from 'ws';
import { MQTT_HOST } from '../shared/relay.js';

// MQTT packets from the app are a few hundred bytes; maps travel the other way.
const MAX_FRAME = 256 * 1024;
// Reaching the broker and being accepted by it (CONNACK). Without a sign-in a
// bridge is of no use to the app, only to someone who wants to hold it open.
const CONNACK_TIMEOUT = 10_000;
// The app pings every 30 s; a bridge that is silent this long is dead.
const IDLE_TIMEOUT = 120_000;
// Bytes waiting for a slow side before the other one is paused.
const HIGH_WATER = 1024 * 1024;
const MAX_BRIDGES = 16;
// One client must not be able to take them all; a household needs one per device in use.
const MAX_PER_CLIENT = 3;

/** The broker a request may be bridged to, or null. */
export function target(url) {
  const host = url.searchParams.get('host') ?? '';
  const port = Number(url.searchParams.get('port'));
  return MQTT_HOST.test(host) && port === 8883 ? { host, port } : null;
}

function bridge(ws, socket, connackTimeout) {
  const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), connackTimeout);
  // The broker's first packet is the CONNACK (type 2); it hangs up itself after a refusal.
  socket.once('data', (chunk) => {
    if (chunk[0] >> 4 === 2) clearTimeout(timer);
  });
  socket.setTimeout(IDLE_TIMEOUT, () => socket.destroy(new Error('idle')));

  ws.on('message', (data) => {
    if (!socket.write(data)) {
      ws.pause();
      socket.once('drain', () => ws.resume());
    }
  });
  socket.on('data', (chunk) => {
    ws.send(chunk, { binary: true }, () => {
      if (socket.isPaused() && ws.bufferedAmount <= HIGH_WATER) socket.resume();
    });
    if (ws.bufferedAmount > HIGH_WATER) socket.pause();
  });

  let failed = false;
  socket.on('error', () => {
    failed = true;
  });
  socket.on('close', () => {
    clearTimeout(timer);
    if (failed) ws.close(1011, 'upstream error');
    else ws.close(1000, 'upstream closed');
  });
  ws.on('error', () => {});
  ws.on('close', () => socket.destroy());
}

/**
 * Returns the handler for an upgrade request to /mqtt whose target and origin
 * were already checked. `connect` opens the upstream socket (tests replace it).
 */
export function createMqttRelay({
  connect = tlsConnect,
  maxBridges = MAX_BRIDGES,
  maxPerClient = MAX_PER_CLIENT,
  connackTimeout = CONNACK_TIMEOUT,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const perClient = new Map();
  return {
    /** No bridge left, in total or for this client (see clientKey). */
    full(client) {
      return wss.clients.size >= maxBridges || (perClient.get(client) ?? 0) >= maxPerClient;
    },
    upgrade(incoming, socket, head, { host, port }, client) {
      wss.handleUpgrade(incoming, socket, head, (ws) => {
        perClient.set(client, (perClient.get(client) ?? 0) + 1);
        ws.on('close', () => {
          const left = perClient.get(client) - 1;
          if (left > 0) perClient.set(client, left);
          else perClient.delete(client);
        });
        bridge(ws, connect({ host, port, servername: host }), connackTimeout);
      });
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
    },
  };
}
