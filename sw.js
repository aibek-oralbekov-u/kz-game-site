const PREFIX = 'kz-game-shell-';
const CACHE = `${PREFIX}2fd9eb6b4e23`;
const RUNTIME_CACHE = 'kz-game-runtime';
const META_CACHE = 'kz-game-meta';
const CURRENT_MANIFEST = '/current-asset-manifest.json';
const PREVIOUS_MANIFEST = '/previous-asset-manifest.json';
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
    // The hub is required to boot the new shell offline; other packs stay lazy.
    for (const [key, entry] of Object.entries(manifest)) {
      if (entry.isEntry || entry.isHub) collect(key);
    }
    await cache.addAll([...assets].map(localRequest));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(CACHE);
    const response = await shell.match('/asset-manifest.json');
    const current = await response.clone().json();
    const meta = await caches.open(META_CACHE);
    const oldCaches = [];
    for (const key of await caches.keys()) {
      if ((key.startsWith(PREFIX) && key !== CACHE) || /^kz-game-v\d+$/.test(key)) {
        oldCaches.push({ key, cache: await caches.open(key) });
      }
    }
    let stored = await meta.match(CURRENT_MANIFEST);
    // Before the split into shell/runtime, the active manifest lived in kz-game-vN.
    if (!stored) {
      for (const { cache } of oldCaches) {
        const manifest = await cache.match('/asset-manifest.json');
        if (manifest) stored = manifest;
      }
    }
    let previous = await meta.match(PREVIOUS_MANIFEST);
    // Repeating activation must not rotate the previous version away.
    if (stored && JSON.stringify(await stored.clone().json()) !== JSON.stringify(current)) {
      previous = stored;
      await meta.put(PREVIOUS_MANIFEST, stored.clone());
    }
    await meta.put(CURRENT_MANIFEST, response.clone());
    const retained = new Set();
    for (const manifest of [current, previous ? await previous.json() : {}]) {
      for (const entry of Object.values(manifest)) {
        for (const path of [entry.file, ...(entry.css || []), ...(entry.assets || [])].filter(Boolean)) {
          const url = new URL(path, self.location.origin);
          if (sameOrigin(url) && url.pathname.startsWith('/assets/')) retained.add(url.href);
        }
      }
    }
    const runtime = await caches.open(RUNTIME_CACHE);
    for (const request of await runtime.keys()) if (!retained.has(request.url)) await runtime.delete(request);
    for (const { key, cache } of oldCaches) {
      // Preserve downloaded images and the previous shell's JS/CSS before deletion.
      for (const request of await cache.keys()) {
        if (!retained.has(request.url) || await runtime.match(request)) continue;
        const cached = await cache.match(request);
        if (cached) await runtime.put(request, cached);
      }
      await caches.delete(key);
    }
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
    const shell = await caches.open(CACHE);
    const runtime = await caches.open(RUNTIME_CACHE);
    const cached = await shell.match(navigation ? '/' : request) || (!navigation && await runtime.match(request));
    if (cached) return cached;
    try {
      if (navigation) return await fetch(request);
      // Static assets are downloaded without credentials and cached only after inspection.
      const response = await fetch(new Request(request, { credentials: 'omit', mode: 'same-origin', redirect: 'error' }));
      if (response.status === 200 && (response.type === 'basic' || response.type === 'default')) {
        const cache = url.pathname.startsWith('/assets/') ? runtime : shell;
        try { await cache.put(request, response.clone()); } catch { /* Return the network response even if caching fails. */ }
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
