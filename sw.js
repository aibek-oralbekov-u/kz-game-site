const PREFIX = 'kz-game-shell-';
const CACHE = `${PREFIX}dc66a2ddfadc`;
const RUNTIME_CACHE = 'kz-game-runtime';
const META_CACHE = 'kz-game-meta';
const CURRENT_MANIFEST = '/current-asset-manifest.json';
const PREVIOUS_MANIFEST = '/previous-asset-manifest.json';
const cacheKey = value => { const url = new URL(value, self.location.origin); return url.origin + url.pathname; };
const sameOrigin = value => new URL(value, self.location.origin).origin === self.location.origin;
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/asset-manifest.json', '/voice-engine/'];
const localRequest = path => new Request(path, { cache: 'reload', credentials: 'omit', mode: 'same-origin', redirect: 'error' });

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map(localRequest));
    const response = await cache.match('/asset-manifest.json');
    const manifest = await response.json();
    const assets = new Set();
    const visited = new Set();
    const collect = (key, jsOnly = false) => {
      const visit = `${jsOnly}:${key}`;
      if (visited.has(visit)) return;
      visited.add(visit);
      const entry = manifest[key];
      if (!entry) throw new Error('Missing build import');
      for (const path of [entry.file, ...(jsOnly ? [] : entry.css || [])].filter(Boolean)) {
        const url = new URL(path, self.location.origin);
        if (!sameOrigin(url) || !url.pathname.startsWith('/assets/')) throw new Error('Nonlocal build asset');
        if (jsOnly && !/\.m?js$/i.test(url.pathname)) continue;
        assets.add(url.href);
      }
      for (const imported of entry.imports || []) collect(imported, jsOnly);
    };
    // Only the hub's JS is required to boot offline; its images stay in runtime.
    for (const [key, entry] of Object.entries(manifest)) {
      if (entry.isEntry && key !== 'voice-test.html') collect(key);
      if (entry.isHub) collect(key, true);
    }
    await cache.addAll([...assets].map(localRequest));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  const activation = (async () => {
    try {
      const shell = await caches.open(CACHE);
      const response = await shell.match('/asset-manifest.json');
      if (!response) return;
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
      const previousManifest = previous ? await previous.json() : {};
      const runtime = await caches.open(RUNTIME_CACHE);
      const visitedPacks = [];
      for (const [key, entry] of Object.entries(previousManifest)) {
        if (key.startsWith('virtual:kz-content/pack/') && current[key] && current[key].file !== entry.file && await runtime.match(cacheKey(entry.file))) visitedPacks.push(key);
      }
      const retained = new Set();
      for (const manifest of [current, previousManifest]) {
        for (const entry of Object.values(manifest)) {
          for (const path of [entry.file, ...(entry.css || []), ...(entry.assets || [])].filter(Boolean)) {
            const url = new URL(path, self.location.origin);
            if (sameOrigin(url) && url.pathname.startsWith('/assets/')) retained.add(cacheKey(url));
          }
        }
      }
      for (const request of await runtime.keys()) if (!retained.has(cacheKey(request.url))) await runtime.delete(request);
      for (const { key, cache } of oldCaches) {
        // Preserve downloaded images and the previous shell's JS/CSS before deletion.
        for (const request of await cache.keys()) {
          if (!retained.has(cacheKey(request.url)) || await runtime.match(cacheKey(request.url))) continue;
          const cached = await cache.match(cacheKey(request.url));
          if (cached) await runtime.put(cacheKey(request.url), cached);
        }
        await caches.delete(key);
      }
      return { current, runtime, visitedPacks };
    } finally { await self.clients.claim(); }
  })();
  event.waitUntil(activation);
  // Best effort after activation: do not hold up fetch events or extend waitUntil.
  void activation.then(async state => {
    if (!state) return;
    const { current, runtime, visitedPacks } = state;
    const paths = new Set();
    const visited = new Set();
    const add = (path, extension) => {
      const url = new URL(path, self.location.origin);
      if (sameOrigin(url) && url.pathname.startsWith('/assets/') && extension.test(url.pathname)) paths.add(cacheKey(url));
    };
    const collect = key => {
      if (visited.has(key)) return;
      visited.add(key);
      const entry = current[key];
      if (!entry) return;
      if (entry.file) add(entry.file, /\.m?js$/i);
      for (const path of entry.css || []) add(path, /\.css$/i);
      for (const path of entry.assets || []) add(path, /\.webp$/i);
      for (const imported of entry.imports || []) collect(imported);
    };
    for (const key of visitedPacks) collect(key);
    for (const path of paths) {
      try {
        if (await runtime.match(path)) continue;
        const response = await fetch(localRequest(path));
        if (response.status === 200 && (response.type === 'basic' || response.type === 'default')) await runtime.put(path, response);
      } catch { /* Offline packages can be fetched on a later visit. */ }
    }
  }).catch(() => {});
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !sameOrigin(request.url)) return;
  const url = new URL(request.url);
  const navigation = request.mode === 'navigate';
  if (navigation && (url.pathname === '/voice-test' || url.pathname.startsWith('/voice-test/') || url.pathname === '/voice-test.html')) return;
  if (!navigation && !PRECACHE.includes(url.pathname) && !url.pathname.startsWith('/assets/')) return;
  if (!navigation && (request.credentials === 'include' || request.headers.has('Authorization'))) return;
  event.respondWith((async () => {
    const shell = await caches.open(CACHE);
    const runtime = await caches.open(RUNTIME_CACHE);
    const engineNavigation = navigation && (url.pathname === '/voice-engine/' || url.pathname === '/voice-engine.html');
    const cached = await shell.match(navigation ? (engineNavigation ? '/voice-engine/' : '/') : cacheKey(url)) || (!navigation && await runtime.match(cacheKey(url)));
    if (cached) return cached;
    try {
      if (navigation) return await fetch(request);
      // Static assets are downloaded without credentials and cached only after inspection.
      const response = await fetch(new Request(request, { credentials: 'omit', mode: 'same-origin', redirect: 'error' }));
      if (response.status === 200 && (response.type === 'basic' || response.type === 'default')) {
        const cache = url.pathname.startsWith('/assets/') ? runtime : shell;
        try { await cache.put(cacheKey(url), response.clone()); } catch { /* Return the network response even if caching fails. */ }
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
