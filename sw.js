// Bump this version whenever publishing a new build (including content changes).
const CACHE = 'kz-game-v1';
const PREFIX = 'kz-game-';
const sameOrigin = value => new URL(value, self.location.origin).origin === self.location.origin;
const localRequest = path => new Request(path, { cache: 'reload', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/asset-manifest.json'].map(localRequest));
    const response = await cache.match('/asset-manifest.json');
    const manifest = await response.json();
    const assets = new Set();
    for (const entry of Object.values(manifest)) {
      for (const path of [entry.file, ...(entry.css || []), ...(entry.assets || [])]) {
        const url = new URL(path, self.location.origin);
        if (!sameOrigin(url) || !url.pathname.startsWith('/assets/')) throw new Error('Nonlocal build asset');
        assets.add(url.href);
      }
    }
    await cache.addAll([...assets].map(localRequest));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !sameOrigin(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      // Cache API performs the same-origin download without recording or application networking.
      await cache.add(new Request(request, { mode: 'same-origin', redirect: 'error' }));
      return (await cache.match(request)) || Response.error();
    } catch {
      return request.mode === 'navigate' ? (await cache.match('/')) || Response.error() : Response.error();
    }
  })());
});
