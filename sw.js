// Bump this version whenever publishing a new build (including content changes).
const CACHE = 'kz-game-v4';
const PREFIX = 'kz-game-';
const sameOrigin = value => new URL(value, self.location.origin).origin === self.location.origin;
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/asset-manifest.json'];
const localRequest = path => new Request(path, { cache: 'reload', credentials: 'omit', mode: 'same-origin', redirect: 'error' });

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map(localRequest));
    const response = await cache.match('/asset-manifest.json');
    const manifest = await response.json();
    const assets = new Set();
    const visited = new Set();
    const collect = key => {
      if (visited.has(key)) return;
      visited.add(key);
      const entry = manifest[key];
      if (!entry) throw new Error('Missing build import');
      for (const path of [entry.file, ...(entry.css || [])].filter(Boolean)) {
        const url = new URL(path, self.location.origin);
        if (!sameOrigin(url) || !url.pathname.startsWith('/assets/')) throw new Error('Nonlocal build asset');
        assets.add(url.href);
      }
      for (const imported of entry.imports || []) collect(imported);
    };
    // Image entries are listed by Vite too; begin only with JS/CSS chunks.
    for (const [key, entry] of Object.entries(manifest)) {
      if (/\.(m?js|css)$/i.test(entry.file || '')) collect(key);
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
  const url = new URL(request.url);
  const navigation = request.mode === 'navigate';
  if (!navigation && !PRECACHE.includes(url.pathname) && !url.pathname.startsWith('/assets/')) return;
  if (!navigation && (request.credentials === 'include' || request.headers.has('Authorization'))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(navigation ? '/' : request);
    if (cached) return cached;
    try {
      if (navigation) return await fetch(request);
      // Static assets are downloaded without credentials and cached only after inspection.
      const response = await fetch(new Request(request, { credentials: 'omit', mode: 'same-origin', redirect: 'error' }));
      if (response.status === 200 && (response.type === 'basic' || response.type === 'default')) {
        try { await cache.put(request, response.clone()); } catch { /* Return the network response even if caching fails. */ }
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
