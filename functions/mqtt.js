// WebSocket <-> TLS bridge to the Roborock MQTT broker. Browsers cannot open raw
// TCP and the broker only listens on 8883, so this passes bytes through
// unchanged. MQTT credentials and the AES-encrypted payloads stay end-to-end
// between browser and broker apart from TLS termination here.

import { connect } from 'cloudflare:sockets';
import { ALLOWED_HOST } from '../shared/relay.js';

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const host = url.searchParams.get('host') ?? '';
  const port = Number(url.searchParams.get('port'));
  if (!ALLOWED_HOST.test(host) || port !== 8883) return new Response('forbidden', { status: 403 });
  if (request.headers.get('Upgrade') !== 'websocket')
    return new Response('websocket expected', { status: 426 });

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
  const writer = socket.writable.getWriter();

  // Depending on the runtime binary frames arrive as ArrayBuffer or Blob; the
  // promise chain keeps the byte order intact while Blobs are being read.
  let queue = Promise.resolve();
  server.addEventListener('message', (e) => {
    queue = queue
      .then(async () => {
        const d = e.data;
        if (typeof d === 'string') return writer.write(new TextEncoder().encode(d));
        return writer.write(new Uint8Array(d instanceof Blob ? await d.arrayBuffer() : d));
      })
      .catch(() => server.close(1011, 'upstream write failed'));
  });
  server.addEventListener('close', () => socket.close().catch(() => {}));
  socket.readable
    .pipeTo(
      new WritableStream({
        write: (chunk) => server.send(chunk),
        close: () => server.close(1000, 'upstream closed'),
      }),
    )
    .catch(() => server.close(1011, 'upstream error'));

  return new Response(null, { status: 101, webSocket: client });
}
