# Server

The app runs on the own server at https://roscoe.krisperapps.de/: Caddy in
front, a small Node service behind it. No secrets, no database; the service
stores nothing.

| What | Where |
|---|---|
| Static files | `/srv/apps/saugi/public`, served by Caddy |
| Relays | service `saugi` (`node server/node.js`, port 8806, loopback only) |
| Delivery | GitHub Actions on every merge to `main` (job "krisperapps.de"), secret `DEPLOY_SSH_KEY` |

```sh
systemctl status saugi          # is the service running?
journalctl -u saugi -n 50       # errors of the relays
cat /srv/apps/saugi/.version    # which version is live
```

The one runtime package, `ws`, is installed by the deploy job
(`npm ci --omit=dev`) and uploaded as `node_modules/`; nothing is installed on
the server. The service needs no environment variables besides `PORT`
(`DB_PATH` and `DATA_DIR` from the unit are unused).

## Requests

Caddy serves every file that exists under `public/` and passes everything else
to the Node service, WebSocket upgrades included:

| Path | What |
|---|---|
| `/` | start page (`public/index.html`; Caddy's `file` matcher does not match a directory) |
| `/rest/<host>/<path>` | HTTPS relay to the Roborock REST API |
| `/mqtt?host=<host>&port=8883` | WebSocket, bridged to a TLS connection to the Roborock MQTT broker |

Anything else answers 404.

## What the relays allow

The relays run on the server's own address, so they must not be usable as a
proxy for anything but this app talking to Roborock:

- Target host: only `<label>.roborock.com` (`shared/relay.js`), reached with
  TLS and a verified certificate. MQTT only on port 8883, REST only on 443.
- Origin: a request that names another site (`Origin`, `Sec-Fetch-Site`) is
  refused; the WebSocket handshake must carry this site's `Origin`.
- REST: only the headers the API needs are forwarded, request bodies up to
  256 KB, 30 s per request, nothing but `Content-Type` comes back as a header.
- MQTT: frames from the browser up to 256 KB, 10 s to reach the broker, closed
  after 120 s without traffic, at most 16 bridges at a time.

## Headers for static files

Static files never reach Node, so Caddy sets their headers. The app needs one:

| Path | Header | Why |
|---|---|---|
| all static files | `Cache-Control: no-cache` | a new version must be seen at once (as on the former host); the service worker does the caching |

```caddy
@static_files not path /rest/* /mqtt
header @static_files Cache-Control no-cache
```

`scripts/dev.mjs` sends the same header locally.
