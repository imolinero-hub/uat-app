/* UAT Dashboard — Service Worker
 * Caches same-origin app assets for faster loads/offline.
 * Ignores cross-origin resources (e.g., CDN Tailwind/Chart.js) to avoid CORS issues.
 * Author: Ildefonso Molinero (project owner)
 * Version: v3
 */

const SW_VERSION = 'v3';
const CACHE_NAME = `uat-cache-${SW_VERSION}`;

// Add the core app files here (same-origin only).
// These are resolved relative to the SW scope (GitHub Pages: e.g. /uat-app/).
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './uat.json',
  './manifest.webmanifest',   // if present
  './icons/icon-192.png',     // if present
  './icons/icon-512.png'      // if present
];

// Small helper to make absolute URLs within this scope
const scopeUrl = (path) => new URL(path, self.location).toString();

/* -------------------------
 * INSTALL: pre-cache core assets
 * ------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const urls = CORE_ASSETS.map(scopeUrl);
      try {
        await cache.addAll(urls);
      } catch (e) {
        // Some optional assets may 404. Cache what we can.
        // We intentionally swallow errors to avoid install failing.
        console.warn('[SW] Precache partial (some files missing):', e);
        for (const url of urls) {
          try { await cache.add(url); } catch (_) { /* ignore individual failures */ }
        }
      }
    })
  );
  // Activate this SW immediately on next page load
  self.skipWaiting();
});

/* -------------------------
 * ACTIVATE: cleanup old caches
 * ------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('uat-cache-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* -------------------------------------------------------------------
 * FETCH:
 * - Ignore cross-origin (CDN) requests → let the network handle them.
 * - For navigations: network-first with cached index.html fallback.
 * - For same-origin GET assets: cache-first, then network & update cache.
 * ------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) Ignore cross-origin (e.g., cdn.tailwindcss.com, jsdelivr.net)
  if (url.origin !== self.location.origin) {
    return; // Do not intercept; avoids CORS breakage
  }

  // 2) Navigations (HTML pages) — network-first with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Optionally: update cached index.html
          const cache = await caches.open(CACHE_NAME);
          cache.put(scopeUrl('./index.html'), fresh.clone());
          return fresh;
        } catch (_) {
          // Offline fallback to cached index.html (if available)
          const cached = await caches.match(scopeUrl('./index.html'));
          return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  // 3) Same-origin assets — cache-first, then network and update cache
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then(async (resp) => {
          // Only cache successful, basic/opaque-safe responses
          try {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, resp.clone());
          } catch (_) {
            // ignore cache put errors
          }
          return resp;
        })
        .catch(() => {
          // As a last resort for JSON or other critical files, try a known fallback if needed
          // Example: if (req.url.endsWith('/uat.json')) return caches.match('./uat.json');
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
    })
  );
});

/* -------------------------
 * Optional: message handler (e.g., to trigger skipWaiting from the page)
 * ------------------------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
