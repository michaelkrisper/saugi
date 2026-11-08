// App shell offline-first so the UI paints instantly; relays are never cached.
// Two caches: the app shell and the icons (most of the bytes). On deploy, CI
// replaces the "dev" in each name with a content hash of that cache's files
// (scripts/stamp-sw.mjs), so a cache gets a new name exactly when one of its
// files changes. 'saugi-data' (last map, owned by app.js) is never touched.
const SHELL_CACHE = 'saugi-shell-dev';
const ASSETS_CACHE = 'saugi-assets-dev';
const OWN = /^saugi-(shell|assets)-/;
const SHELL = [
  '/',
  '/js/app.js',
  '/js/api.js',
  '/js/crypto.js',
  '/js/map.js',
  '/js/mqtt.js',
  '/js/protocol.js',
  '/js/robot.js',
  '/js/schedule.js',
  '/manifest.webmanifest',
];
const ASSETS = ['/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

// Fetches only what a cache of the same name does not hold yet, past the HTTP
// cache, so a new cache name never stores an outdated file.
const fill = (name, paths) =>
  caches
    .open(name)
    .then((c) =>
      Promise.all(paths.map(async (p) => (await c.match(p)) || c.add(new Request(p, { cache: 'reload' })))),
    );

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([fill(SHELL_CACHE, SHELL), fill(ASSETS_CACHE, ASSETS)]).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => OWN.test(k) && k !== SHELL_CACHE && k !== ASSETS_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: serve from cache, refresh in the background. Icons
// change only together with the assets cache's name, so a hit is final.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/rest/') || url.pathname === '/mqtt') return;
  const asset = ASSETS.includes(url.pathname);
  e.respondWith(
    caches.open(asset ? ASSETS_CACHE : SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached && asset) return cached;
      const fresh = fetch(e.request)
        .then((r) => {
          if (r.ok) cache.put(e.request, r.clone());
          return r;
        })
        .catch(() => cached);
      if (cached) {
        e.waitUntil(fresh);
        return cached;
      }
      return fresh;
    }),
  );
});
