// uat-app/service-worker.js
const CACHE_NAME = 'uat-shell-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  // NOTE: no CDN entries here (they’ll be network-only)
];

// Install: pre-cache only same-origin shell files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch(() => Promise.resolve())
  );
  self.skipWaiting();
});

// Activate: cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// Fetch:
// - Cross-origin (CDNs) -> network-only (no interception/caching)
// - uat.json -> network-first with cached fallback
// - same-origin shell -> cache-first
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Cross-origin -> let the browser handle it (avoids CORS/opaque issues)
  if (url.origin !== self.location.origin) {
    return; // do not call respondWith
  }

  // 2) Data file -> network-first
  const isUatJson = url.pathname.endsWith('/uat.json') || url.pathname.endsWith('uat.json');
  if (isUatJson) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      }).catch(async () => {
        const cached = await caches.match(req);
        return cached || new Response(JSON.stringify({
          overview:{release:"",inScope:0,lastUpdate:""},
          progressDaily:[], issues:[], teams:[], keyDates:[]
        }), { headers: { 'Content-Type': 'application/json' }});
      })
    );
    return;
  }

  // 3) Same-origin shell -> cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (req.method === 'GET' && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
