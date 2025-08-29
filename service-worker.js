const CACHE_NAME = 'uat-shell-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './charts/execution.png',
  './charts/defects.png'
];

// Install: pre-cache same-origin shell only
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch(() => Promise.resolve())
  );
  self.skipWaiting();
});

// Activate: cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k)))))
  );
  self.clients.claim();
});

// Fetch:
// - Cross-origin (CDNs) -> let browser handle (avoid CORS/opaque).
// - uat.json -> network-first with cached fallback.
// - same-origin shell -> cache-first.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    return; // do not intercept cross-origin requests
  }

  const isUatJson = url.pathname.endsWith('/uat.json') || url.pathname.endsWith('uat.json');
  if (isUatJson) {
    event.respondWith(
      fetch(req).then((res) => {
        caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone()));
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

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (req.method === 'GET' && res.status === 200) {
          caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone()));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
