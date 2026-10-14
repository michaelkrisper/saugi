// App shell offline-first so the UI paints instantly; relays are never cached.
const CACHE = 'saugi-shell-v8';
const SHELL = [
  '/',
  '/js/app.js',
  '/js/api.js',
  '/js/crypto.js',
  '/js/map.js',
  '/js/mqtt.js',
  '/js/protocol.js',
  '/js/robot.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('saugi-shell') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: serve from cache, refresh in the background.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/rest/') || url.pathname === '/mqtt') return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
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
