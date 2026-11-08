# CLAUDE.md

Roscoe (repo/domain `saugi`): a minimal remote for Roborock vacuums as an installable
web app: start/pause/resume, go home, live map with path and zones. The browser speaks
the Roborock protocol itself (login, MQTT, AES, map parsing in `public/js/`); two
stateless Cloudflare Pages Functions only relay bytes to `*.roborock.com`. Vanilla ES
modules, no build step, no runtime dependencies. Hosted on Cloudflare Pages
(https://saugi.pages.dev), deployed by CI. UI English.

## Commands

Node 26 (`.nvmrc`).

```sh
npm ci
npm run dev                       # wrangler pages dev (public/ + functions/) on :8792
npm run check                     # Biome + node:test unit tests = CI job "quality"
npm run lint:fix                  # apply Biome fixes
node scripts/browser-check.mjs http://localhost:8792 [outdir]   # headless Chrome screenshots
npm run deploy                    # manual deploy: stamps a copy in dist/, wrangler pages deploy
```

- CI (`deploy.yml`, workflow "Deploy"): `quality` on every push/PR; on `main`
  "Version tag", then `deploy` stamps `public/sw.js` and runs `wrangler pages deploy`.
  Needs secret `CLOUDFLARE_API_TOKEN` and variable `CLOUDFLARE_ACCOUNT_ID`; without
  the token the deploy is skipped with a warning.
- The browser check is not in CI. It signs in with fake credentials (the broker
  rejects them) and seeds a cached status and the fixture map, so it never drives a
  real vacuum.

## Architecture

- `public/js/api.js`: e-mail-code login, device list, Hawk-signed REST calls via
  `/rest/<host>/<path>`. `mqtt.js`: minimal MQTT 3.1.1 client over WebSocket (`/mqtt`).
  `protocol.js`: protocol `1.0` framing, AES-ECB with timestamp-derived keys, map
  responses. `crypto.js`: MD5, CRC32, AES-ECB emulated on WebCrypto AES-CBC.
  `map.js`: map parser and rasteriser. `robot.js`: RPC layer (`get_status`,
  `get_map_v1`, ...). `app.js`: UI, polling (map every 3 s while moving), commands.
- `functions/rest/[[path]].js` and `functions/mqtt.js` (WebSocket <-> TLS 8883 via
  `cloudflare:sockets`) share the host allowlist in `shared/relay.js`. They exist
  only because the Roborock REST API sends no CORS headers and the broker speaks raw
  TLS; keep them stateless and limited to `*.roborock.com`.
- State: IoT credentials, status and room names in `localStorage` (`saugi.*`), the
  last map in the cache `saugi-data` (written by `app.js`, cleared on sign-out).
- Only protocol `1.0` devices are supported (S series; developed with an S7,
  `roborock.vacuum.a15`); `A01`/`B01`/`L01` devices are skipped at sign-in.

## Service worker (`public/sw.js`)

- Two caches: `saugi-shell-<hash>` (`SHELL`: index, JS, manifest) and
  `saugi-assets-<hash>` (`ASSETS`: icons, most of the bytes). The repo holds `-dev`
  instead of the hash; the deploy runs `scripts/stamp-sw.mjs`, which hashes each
  list's files. A cache is renamed exactly when its files change. Never bump anything
  by hand.
- Install fetches only what a cache of the same name lacks (`cache: 'reload'`). Shell
  requests are stale-while-revalidate, icon hits are final, `/rest/` and `/mqtt` are
  never cached. A new file goes into `SHELL` or `ASSETS`; `tests/stamp-sw.test.js`
  fails if a listed file does not exist.
- Activate deletes only outdated `saugi-shell-`/`saugi-assets-` caches. Never widen
  that to `saugi-`: it would wipe `saugi-data`.

## Conventions

- Biome (single quotes, 110 columns) covers `public/js`, `public/sw.js`, `functions/`,
  `shared/`, `tests/`, `scripts/*.mjs`, root JSON; not HTML/CSS.
- UI text, code, comments and commits English. Dev dependencies only (Biome, wrangler).

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
- Locally (wrangler/workerd) binary WebSocket frames arrive as `Blob`, live as
  `ArrayBuffer`; the MQTT relay handles both. Keep it that way.
- A refused MQTT connection (CONNACK 5) can also mean rate limiting, not only invalid
  credentials; the app then shows "Sign-in expired". A retry backoff was considered and
  deliberately not built; only add one if this causes real problems.
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
- Merging to `main` deploys to Cloudflare Pages automatically (Deploy workflow).
- Details: CONTRIBUTING.md.
