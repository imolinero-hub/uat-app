// service-worker.js
/* UAT Dashboard SW: cache-busts on deploy via ?v=VERSION in the SW URL */

const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE_NAME = `uat-cache-${VERSION}`;

// Everything served from your GitHub Pages origin:
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './uat.json',
  // icons (optional—keep only ones you actually have)
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// --- Install: cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// --- Activate: drop old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

// --- Fetch: same-origin only
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle this site’s own files
  if (url.origin !== self.location.origin || req.method !== 'GET') return;

  // Network-first for the data JSON so stats refresh quickly
  if (url.pathname.endsWith('/uat.json')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Stale-while-revalidate for everything else (HTML/CSS/JS/icons)
  event.respondWith(staleWhileRevalidate(req));
});

// --- Strategies

async function networkFirst(request) {
  try {
    // cache-bust the JSON to avoid stale proxies
    const url = new URL(request.url);
    url.searchParams.set('b', Date.now().toString());
    const fresh = await fetch(url.toString(), { cache: 'no-store' });
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('{"error":"offline"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  // Return fast if we have cache, otherwise wait for network
  return cached || (await fetchPromise) || new Response('', { status: 504 });
}
