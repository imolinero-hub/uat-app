// uat-app/service-worker.js
const CACHE = 'uat-cache-v4'; // bump when you ship

self.addEventListener('install', evt => {
  self.skipWaiting(); // take control ASAP
  evt.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      './', './index.html', './uat.json',
      './manifest.webmanifest',
      './icons/icon-192.png', './icons/icon-512.png'
      // add ./about-uat.md if you use it
    ]))
  );
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim(); // update open pages
});

self.addEventListener('fetch', evt => {
  const url = new URL(evt.request.url);
  // Always network-first for uat.json to stay fresh
  if (url.pathname.endsWith('/uat.json')) {
    evt.respondWith(fetch(evt.request).catch(() => caches.match(evt.request)));
    return;
  }
  // Cache-first for static
  evt.respondWith(
    caches.match(evt.request).then(r => r || fetch(evt.request))
  );
});
