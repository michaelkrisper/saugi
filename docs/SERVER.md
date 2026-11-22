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
journalctl -u saugi -n 50       # errors of the service
cat /srv/apps/saugi/.version    # which version is live
```

The service has no dependencies; nothing is installed on the server.

| Secret | Where |
|---|---|
| Code word | `SITE_CODE=...` in `/etc/krisperapps/saugi.env` (root:saugi, 640); restart the service after a change. Changing it locks every browser out until the new word is entered. Without it the app does not work (`/api` answers 404). |
| Sign-in to Roborock and Xiaomi | `/var/lib/saugi/config.json` (`DATA_DIR`, mode 600), written by the service when someone signs in through the app. Deleting it (service stopped) signs the app out. |

Neither ever reaches a browser: the app gets a cookie derived from the code word
and, from `/api/state`, the vacuums' names and rooms.

## Requests

Caddy serves every file that exists under `public/` and passes everything else
to the Node service:

| Path | What |
|---|---|
| `/` | start page (`public/index.html`; Caddy's `file` matcher does not match a directory) |
| `/api/unlock` | takes the code word, sets the cookie `roscoe_access` (HttpOnly, one year) |
| `/api/...` | the app's calls: state, sign-in steps, status, map, RPCs from an allowlist, schedules (`server/api.js`) |

Anything else answers 404. Everything but `/`, the static files and
`/api/unlock` answers 401 without the cookie.

The service itself talks to Roborock (REST, and one MQTT connection to the
broker for all browsers, dropped after 5 minutes without a request) and to the
Xiaomi cloud, only to the hosts in `shared/relay.js`, with TLS and a verified
certificate; redirects are not followed. There is no relay: a browser cannot
make the server reach a host of its choice.

Per client: 5 guesses of the code word per 10 minutes, 180 `/api` requests per
minute (commands and the second vacuum's status; the first vacuum's status and
map come over one event stream, `/api/events`, at most 20 at a time), 6 sign-in
steps per 10 minutes (each can make Roborock or Xiaomi send a code). `/api` requests other than GET must carry this site's
`Origin`.

## Headers for static files

Static files never reach Node, so Caddy sets their headers. The app needs one:

| Path | Header | Why |
|---|---|---|
| all static files | `Cache-Control: no-cache` | a new version must be seen at once (as on the former host); the service worker does the caching |

```caddy
@static file
handle @static {
	header Cache-Control no-cache
	file_server
}
```

`scripts/dev.mjs` sends the same header locally.
