# CLAUDE.md

Roscoe (repo/domain `saugi`): a minimal remote for Roborock vacuums as an installable
web app: start/pause/resume, go home, live map with path and zones. Private: a code
word opens it. The server holds the vacuums' sign-in and speaks the Roborock protocol
(login, MQTT, AES in `public/js/`, run by Node); the browser talks only to the
server's `/api` and never gets a key. Vanilla ES modules, no build step; the server's
one runtime dependency is `ws`. Hosted on the own server
(https://roscoe.krisperapps.de: Caddy serves `public/`, a Node service the rest),
deployed by CI. UI English.

## Commands

Node 26 (`.nvmrc`).

```sh
npm ci
npm run dev                       # scripts/dev.mjs (public/ + server, code word "dev") on :8792
npm run check                     # Biome + node:test unit tests = CI job "quality"
npm run lint:fix                  # apply Biome fixes
node scripts/browser-check.mjs http://localhost:8792 [outdir]   # headless Chrome screenshots
```

- CI (`deploy.yml`, workflow "Deploy"): `quality` on every push/PR; on `main`
  "Version tag", then job `server` ("krisperapps.de") writes the tag into
  `public/js/version.js` (the repo holds `dev`; shown at the bottom of the main screen as `v1.2.3`),
  stamps `public/sw.js`, installs
  `ws` into the upload folder (`npm ci --omit=dev`; the server has no npm), rsyncs it to
  the server (secret `DEPLOY_SSH_KEY`) and verifies the live site (locked: 401 without
  the code word). The server restarts the service when `.version` changes. No manual deploy.
- The browser check is not in CI. It enters the code word, hands the server fake
  credentials (the broker rejects them) and seeds a cached status and the fixture map,
  so it never drives a real vacuum. It needs a freshly started `npm run dev` (the
  server must hold no sign-in) and `google-chrome` on the PATH.

## Architecture

- Access (`server/access.js`): `SITE_CODE` (on the server in
  `/etc/krisperapps/saugi.env`, never in the repo or in output) is the code word.
  `POST /api/unlock` sets the cookie `roscoe_access` (HMAC of the code word, HttpOnly);
  without it `/api` and the relays answer 401. Without `SITE_CODE` there is no `/api`
  and the app cannot work.
- Sign-in (`server/vacuums.js`): the server keeps it in `DATA_DIR/config.json`
  (Roborock `rriot` and device key, Xiaomi session) and runs the protocol modules from
  `public/js/` itself: one MQTT connection to the broker for all browsers (direct TLS,
  dropped after 5 idle minutes), `api.js` through the REST function in-process, the
  Xiaomi cloud over `fetch`. Nothing of the sign-in may ever be sent to a browser:
  `/api/state` gives names and rooms only (`tests/access.test.js` checks that). When a
  sign-in expires the app asks again and posts the steps (`/api/rr/login`,
  `/api/mi/login`: e-mail code, captcha, 2FA code); the result is stored on the server.
  A browser of an older version hands its sign-in over once (`/api/adopt`).
- `server/api.js`: the `/api` routes. RPCs go through `/api/<rr|mi>/rpc` and the
  allowlists `RR_METHODS`/`MI_METHODS` in `vacuums.js`; a new RPC in the app needs an
  entry there.
- `public/js/remote.js`: the browser's side of `/api` (`RemoteRobot`, same interface
  as `Robot`/`MiRobot`). `app.js`: UI, polling (status every 2 s and map every 3 s
  while moving; no push), commands.
- `public/js/api.js`: e-mail-code login, device list, Hawk-signed REST calls via
  `/rest/<host>/<path>`. `mqtt.js`: minimal MQTT 3.1.1 client (over the relay's
  WebSocket or a socket the caller opens). `protocol.js`: protocol `1.0` framing,
  AES-ECB with timestamp-derived keys, map responses. `crypto.js`: MD5, CRC32, AES-ECB
  emulated on WebCrypto AES-CBC. `robot.js`: RPC layer (`get_status`, `get_map_v1`,
  ...). These run on the server; they stay in `public/js/` and stay runnable in a
  browser (the relays and `tests/` use them that way). `map.js`: map parser and
  rasteriser, in the browser.
- `functions/rest/[[path]].js` (written as a Pages Function, `onRequest({ request,
  params })`, and kept that way) and `server/mqtt.js` (WebSocket via `ws` <-> TLS 8883
  via `node:tls`) share the host allowlist in `shared/relay.js`. The app no longer
  uses the relays from the browser (only the REST function, in-process); they remain,
  behind the code word. Keep them stateless (the per-client limits in `server/limit.js` are the one
  exception, in memory) and limited to the Roborock hosts the app uses.
- `server/node.js`: node:http entry, loopback only. Routes `/rest/*`, `/mqtt` (upgrade)
  and `/` (Caddy passes directories on, so the entry answers the start page); checks
  the origin and the body size. Static files never reach it: Caddy serves `public/`
  (`scripts/dev.mjs` locally). The relays sit on the server's own address: every limit
  in `docs/SERVER.md` ("What the relays allow") stays, so they cannot serve as a proxy.
- `xiaomi.js`: optional second vacuum paired with Xiaomi Home (`cfg.mi`): password
  sign-in with captcha and 2FA code, RC4-signed cloud API, miIO RPC via
  `/home/rpc/<did>` (`MiRobot`, same interface as `Robot`, polled, no push). Its relay
  `functions/mi/[[path]].js` reaches only the Xiaomi account and API hosts (`MI_HOST`).
  Xiaomi signs in with cookies and redirects, so that relay takes cookies as
  `x-mi-cookie`, never follows redirects and returns the upstream status, `Location`
  and the cookies set in `x-mi-*` headers. The limits in `docs/SERVER.md` apply to it too.
- State in the browser: status and room names in `localStorage` (`saugi.*`), the last
  map in the cache `saugi-data` (written by `app.js`, cleared on sign-out). No
  credentials. Signing out signs the server out, i.e. everyone.
- Only protocol `1.0` devices are supported (S series; developed with an S7,
  `roborock.vacuum.a15`); `A01`/`B01`/`L01` devices are skipped at sign-in.

## Service worker (`public/sw.js`)

- Two caches: `saugi-shell-<hash>` (`SHELL`: index, JS, manifest) and
  `saugi-assets-<hash>` (`ASSETS`: icons, most of the bytes). The repo holds `-dev`
  instead of the hash; the deploy runs `scripts/stamp-sw.mjs`, which hashes each
  list's files. A cache is renamed exactly when its files change. Never bump anything
  by hand.
- Install fetches only what a cache of the same name lacks (`cache: 'reload'`). Shell
  requests are stale-while-revalidate, icon hits are final, `/api/`, `/rest/`, `/mi/` and `/mqtt` are
  never cached. A new file goes into `SHELL` or `ASSETS`; `tests/stamp-sw.test.js`
  fails if a listed file does not exist.
- Activate deletes only outdated `saugi-shell-`/`saugi-assets-` caches. Never widen
  that to `saugi-`: it would wipe `saugi-data`.

## Conventions

- Biome (single quotes, 110 columns) covers `public/js`, `public/sw.js`, `functions/`,
  `server/`, `shared/`, `tests/`, `scripts/*.mjs`, root JSON; not HTML/CSS.
- UI text, code, comments and commits English. One runtime dependency (`ws`, pure
  JS, shipped by the deploy), one dev dependency (Biome). Nothing else at runtime.

## Rules and pitfalls

- Protocol code is a port of python-roborock 7.12 and vacuum-map-parser-roborock;
  `tests/fixtures/vectors.json` holds reference values generated with python-roborock.
  For protocol questions, check against those libraries, and add new vectors from them
  rather than from our own output.
- Second source when those libraries have no answer (RPC parameters, call order): the
  Roborock app's device plugin. The APK holds no device logic; the S7 plugin
  (product id 23 from `/api/v4/product`) comes from `POST <baseUrl>/api/v1/appplugin`
  `{"apilevel":99999,"productids":[23],"type":2}` with the user token (python-roborock
  `download_code`). The zip holds Hermes bytecode (`index.android.bundle`); decompile
  with `hbc-decompiler` (P1sec/hermes-dec) and search for the RPC name. Good for
  reading call shapes only; vectors still come from python-roborock.
- Testing against a real vacuum: only read-only RPCs (`get_status`, `get_map_v1`,
  `get_room_mapping`). Never send movement commands (`app_start`, `app_pause`,
  `app_charge`, ...) without the owner's explicit OK.
- `tests/node.test.js` runs the bridge against a local TLS echo server with a
  throwaway `*.roborock.com` certificate (needs `openssl`). A real vacuum is not part
  of any automated test.
- A refused MQTT connection (CONNACK 5) can also mean rate limiting, not only invalid
  credentials; the app then shows "Sign-in expired". A retry backoff was considered and
  deliberately not built; only add one if this causes real problems.
- Xiaomi Home vacuum (developed with a Roborock E5, `roborock.vacuum.a01`): reference is
  PiotrMachowski/Xiaomi-cloud-tokens-extractor; `tests/fixtures/xiaomi-vectors.json` holds
  values computed with its signing functions. Same RPCs as the S7 for status and commands.
  Its schedule is a timer on the vacuum (`get_timer`/`set_timer`/`upd_timer`/`del_timer`,
  cron in the vacuum's time zone); the app edits the oldest one.
  The E5 answers no map RPC over the cloud, idle or cleaning (`get_map_v1`: "user ack timeout");
  only `get_clean_record_map [begin]` gives an object name (`saplite/<did>/<uid>/<0-9>`, ten
  slots written after each run, fetched via
  `/home/getmapfileurl` with the name URL-decoded) in the `RRSA` format, parsed by
  `litemap.js` (202 x 202 fields of 15 cm, origin and heading are where that run started,
  so every run has its own frame). Reference for the format: the Xiaomi Home plugin of
  `roborock.vacuum.a01` (`/v2/plugin/fetch_plugin` gives the zip; plain JS,
  `Parser/MapParser` in `main.bundle`).
  `align.js` fits the last run onto the S7's map (search over heading and shift on a
  150 mm grid; runs under about 6 m2 or with a poor fit are not shown, unless the map
  holds the dock: it stands in the room `MI_DOCK_ROOM` in `app.js` ("Bad"; change it there
  when the dock moves), the charger must land there and 1.5 m2 will do) and `app.js` draws
  it as an overlay with the end position. The download goes through `/mi/` to
  `<name>.fds.api.xiaomi.com`.
- Schedules (`schedule.js`) live in two places, as in the Roborock app's S7 plugin: a
  cloud job (`/user/devices/<duid>/jobs`) and a vacuum entry (`set_server_timer`, same
  name). The Roborock app lists only jobs the vacuum knows, and the cloud does not sync
  on/off to the vacuum (`upd_server_timer`). Day numbers: 0 = Sunday.
- iOS: 26 px extra top padding under the safe area (the status bar blur covers content
  otherwise); zoom and scrolling are disabled on purpose.

## Workflow

- Every change starts with a GitHub issue. Branch `<issue>-<slug>` from `main`,
  open a PR with `Closes #<issue>`. Never push to `main` directly.
- PRs auto-merge (squash) once CI and the "Linked ticket" check pass; drafts are not merged.
- Versions exist only as git tags `vX.Y.Z`. Every merge to `main` tags the next patch;
  never edit version numbers in files. Minor/major releases: Actions -> Release.
- Merging to `main` deploys to the own server automatically (Deploy workflow).
- Details: CONTRIBUTING.md.
