# Server

The app runs on the own server at https://roscoe.krisperapps.de/: Caddy in
front, a small Node service behind it. The service holds two secrets: the code
word that opens the app and the vacuums' sign-in.

| What | Where |
|---|---|
| Static files | `/srv/apps/saugi/public`, served by Caddy |
| Server | service `saugi` (`node server/node.js`, port 8806, loopback only) |
| Delivery | GitHub Actions on every merge to `main` (job "krisperapps.de"), secret `DEPLOY_SSH_KEY` |

```sh
systemctl status saugi          # is the service running?
journalctl -u saugi -n 50       # errors of the relays
cat /srv/apps/saugi/.version    # which version is live
```

The one runtime package, `ws`, is installed by the deploy job
(`npm ci --omit=dev`) and uploaded as `node_modules/`; nothing is installed on
the server.

| Secret | Where |
|---|---|
| Code word | `SITE_CODE=...` in `/etc/krisperapps/saugi.env` (root:saugi, 640); restart the service after a change. Changing it locks every browser out until the new word is entered. Without it the app does not work (`/api` answers 404). |
| Sign-in to Roborock and Xiaomi | `/var/lib/saugi/config.json` (`DATA_DIR`, mode 600), written by the service when someone signs in through the app. Deleting it (service stopped) signs the app out. |

Neither ever reaches a browser: the app gets a cookie derived from the code word
and, from `/api/state`, the vacuums' names and rooms.

## Requests

Caddy serves every file that exists under `public/` and passes everything else
to the Node service, WebSocket upgrades included:

| Path | What |
|---|---|
| `/` | start page (`public/index.html`; Caddy's `file` matcher does not match a directory) |
| `/api/unlock` | takes the code word, sets the cookie `roscoe_access` (HttpOnly, one year) |
| `/api/...` | the app's calls: state, sign-in steps, status, map, RPCs from an allowlist, schedules (`server/api.js`) |
| `/rest/<host>/<path>` | HTTPS relay to the Roborock REST API |
| `/mi/<host>/<path>` | HTTPS relay to the Xiaomi cloud (second vacuum from Xiaomi Home) |
| `/mqtt?host=<host>&port=8883` | WebSocket, bridged to a TLS connection to the Roborock MQTT broker |

Anything else answers 404. Everything but `/`, the static files and
`/api/unlock` answers 401 without the cookie.

The service itself talks to Roborock (REST, and one MQTT connection to the
broker for all browsers, dropped after 5 minutes without a request) and to the
Xiaomi cloud, to the same hosts the relays allow. The app in the browser no
longer uses the relays; they remain, behind the code word.

Per client: 5 guesses of the code word per 10 minutes, 180 `/api` requests per
minute (the app polls), 6 sign-in steps per 10 minutes (each can make Roborock
or Xiaomi send a code). `/api` requests other than GET must carry this site's
`Origin`.

## What the relays allow

The relays run on the server's own address, so they must not be usable as a
proxy for anything but this app talking to Roborock (and, for a second vacuum
from Xiaomi Home, to the Xiaomi cloud):

- Target host: only the regional Roborock hosts the app uses (`shared/relay.js`):
  `<region>iot` and `api-<region>` over REST, `mqtt-<region>` over MQTT, reached
  with TLS and a verified certificate. MQTT only on port 8883, REST only on 443;
  a redirect is not followed (502).
- Origin: a request that names another site (`Origin`, `Sec-Fetch-Site`) is
  refused; the WebSocket handshake and every REST request other than GET/HEAD
  must carry this site's `Origin`.
- Per client (the address Caddy passes as `CF-Connecting-IP`, IPv6 by /64; kept
  in memory only): 30 REST requests per minute, 6 code mail requests per
  10 minutes (429 beyond that), 3 MQTT bridges.
- REST: only the headers the API needs are forwarded, request bodies up to
  256 KB, 30 s per request. Answers are always labelled JSON, with `nosniff` and
  a sandboxing `Content-Security-Policy`, whatever the upstream host sends. The
  app sends the query string (e-mail address, sign-in code) in the header
  `X-Relay-Query`; the relay puts it back into the URL for Roborock.
- Xiaomi (`/mi/`): only `account.xiaomi.com`, the map store `<name>.fds.api.xiaomi.com` and the `api.io.mi.com` hosts (regions
  and `sts`), same origin rule, body size, timeout and answer labelling as REST
  (`application/octet-stream`). 60 requests per minute per client (the vacuum's
  status is polled), 10 password or code-sending calls per 10 minutes. A redirect is
  not followed but handed to the app (`x-mi-status`, `x-mi-headers`), which requests
  the next hop through the same allowlist; cookies travel in `x-mi-cookie` /
  `x-mi-set-cookie`, the query in `X-Relay-Query`.
- MQTT: frames from the browser up to 256 KB, 10 s until the broker has
  accepted the sign-in (CONNACK), closed after 120 s without traffic, at most
  16 bridges at a time.

## Headers for static files

Static files never reach Node, so Caddy sets their headers. The app needs one:

| Path | Header | Why |
|---|---|---|
| all static files | `Cache-Control: no-cache` | a new version must be seen at once (as on the former host); the service worker does the caching |

```caddy
@static_files not path /rest/* /mi/* /mqtt
header @static_files Cache-Control no-cache
```

`scripts/dev.mjs` sends the same header locally.
