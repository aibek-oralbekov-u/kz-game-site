const PREFIX = 'kz-game-shell-';
const CACHE = `${PREFIX}28fdf63c0d41`;
const RUNTIME_CACHE = 'kz-game-runtime';
const META_CACHE = 'kz-game-meta';
const CURRENT_MANIFEST = '/current-asset-manifest.json';
const PREVIOUS_MANIFEST = '/previous-asset-manifest.json';
const cacheKey = value => { const url = new URL(value, self.location.origin); return url.origin + url.pathname; };
const sameOrigin = value => new URL(value, self.location.origin).origin === self.location.origin;
// KZ-30c: install reads the reduced manifest (no mp3/webp); the full one is fetched after activation.
const PRECACHE_MANIFEST = '/precache-manifest.json';
const FULL_MANIFEST = '/asset-manifest.json';
const MEDIA = /\.(?:mp3|webp)$/i;
// KZ-40e: background loops (public/ambience, names without a build hash) — runtime cache on first play; not listed in any
// manifest, so the activation of the next build prunes them with the other unlisted media and they are fetched again.
const ambience = path => path.startsWith('/ambience/') && /\.mp3$/i.test(path);
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', PRECACHE_MANIFEST, '/voice-engine/'];
const localRequest = path => new Request(path, { cache: 'reload', credentials: 'omit', mode: 'same-origin', redirect: 'error' });
const accepted = response => response.status === 200 && (response.type === 'basic' || response.type === 'default');
const buildFiles = manifest => new Set(Object.values(manifest).map(entry => entry.file).filter(Boolean));
// Same build: every file of the reduced manifest is listed in the other one (reduced or full).
const sameBuild = (reduced, other) => { const files = buildFiles(other); return [...buildFiles(reduced)].every(file => files.has(file)); };
const assetPaths = manifests => {
  const paths = new Set();
  for (const manifest of manifests) {
    for (const entry of Object.values(manifest)) {
      for (const path of [entry.file, ...(entry.css || []), ...(entry.assets || [])].filter(Boolean)) {
        const url = new URL(path, self.location.origin);
        if (sameOrigin(url) && url.pathname.startsWith('/assets/')) paths.add(cacheKey(url));
      }
    }
  }
  return paths;
};

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map(localRequest));
    const response = await cache.match(PRECACHE_MANIFEST);
    const manifest = await response.json();
    const assets = new Set();
    const visited = new Set();
    const add = path => {
      const url = new URL(path, self.location.origin);
      if (!sameOrigin(url) || !url.pathname.startsWith('/assets/')) throw new Error('Nonlocal build asset');
      if (!MEDIA.test(url.pathname)) assets.add(url.href);
    };
    const collect = (key, jsOnly = false) => {
      const visit = `${jsOnly}:${key}`;
      if (visited.has(visit)) return;
      visited.add(visit);
      const entry = manifest[key];
      if (!entry) throw new Error('Missing build import');
      for (const path of [entry.file, ...(jsOnly ? [] : entry.css || [])].filter(Boolean)) {
        if (jsOnly && !/\.m?js$/i.test(new URL(path, self.location.origin).pathname)) continue;
        add(path);
      }
      for (const imported of entry.imports || []) collect(imported, jsOnly);
    };
    // The hub boots offline from its JS and its world texts (json); its images stay in runtime.
    for (const [key, entry] of Object.entries(manifest)) {
      if (entry.isEntry && key !== 'voice-test.html') collect(key);
      if (entry.isHub) {
        collect(key, true);
        for (const path of entry.assets || []) if (/\.json$/i.test(new URL(path, self.location.origin).pathname)) add(path);
      }
    }
    await cache.addAll([...assets].map(localRequest));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  const activation = (async () => {
    try {
      const shell = await caches.open(CACHE);
      const response = await shell.match(PRECACHE_MANIFEST);
      if (!response) return;
      const current = await response.clone().json();
      const meta = await caches.open(META_CACHE);
      const oldCaches = [];
      for (const key of await caches.keys()) {
        if ((key.startsWith(PREFIX) && key !== CACHE) || /^kz-game-v\d+$/.test(key)) {
          oldCaches.push({ key, cache: await caches.open(key) });
        }
      }
      const active = await meta.match(CURRENT_MANIFEST);
      let stored = active;
      // Before the split into shell/runtime, the active manifest lived in kz-game-vN.
      if (!stored) {
        for (const { cache } of oldCaches) {
          const manifest = await cache.match(FULL_MANIFEST) || await cache.match(PRECACHE_MANIFEST);
          if (manifest) stored = manifest;
        }
      }
      let previous = await meta.match(PREVIOUS_MANIFEST);
      // Repeating activation must not rotate the previous version away (nor drop a fetched full manifest).
      const rotate = stored && !sameBuild(current, await stored.clone().json());
      if (rotate) {
        previous = stored;
        await meta.put(PREVIOUS_MANIFEST, stored.clone());
      }
      if (!active || rotate) await meta.put(CURRENT_MANIFEST, response.clone());
      const previousManifest = previous ? await previous.clone().json() : {};
      const runtime = await caches.open(RUNTIME_CACHE);
      const visitedPacks = [];
      for (const [key, entry] of Object.entries(previousManifest)) {
        if (key.startsWith('virtual:kz-content/pack/') && current[key] && current[key].file !== entry.file && await runtime.match(cacheKey(entry.file))) visitedPacks.push(key);
      }
      // mp3/webp are listed only in the full manifest: they are pruned after it is fetched.
      const retained = assetPaths([current, previousManifest]);
      const keep = path => retained.has(path) || MEDIA.test(new URL(path).pathname);
      for (const request of await runtime.keys()) if (!keep(cacheKey(request.url))) await runtime.delete(request);
      for (const { key, cache } of oldCaches) {
        // Preserve downloaded images and the previous shell's JS/CSS before deletion.
        for (const request of await cache.keys()) {
          if (!keep(cacheKey(request.url)) || await runtime.match(cacheKey(request.url))) continue;
          const cached = await cache.match(cacheKey(request.url));
          if (cached) await runtime.put(cacheKey(request.url), cached);
        }
        await caches.delete(key);
      }
      return { current, meta, previousManifest, runtime, visitedPacks };
    } finally { await self.clients.claim(); }
  })();
  event.waitUntil(activation);
  // Best effort after activation: do not hold up fetch events or extend waitUntil.
  void activation.then(async state => {
    if (!state) return;
    const { current, meta, previousManifest, runtime, visitedPacks } = state;
    let full;
    try {
      const response = await fetch(localRequest(FULL_MANIFEST));
      if (accepted(response)) {
        const manifest = await response.clone().json();
        // A newer deployment between install and activation must not decide what this version keeps.
        if (sameBuild(current, manifest)) {
          full = manifest;
          await meta.put(CURRENT_MANIFEST, response);
        }
      }
    } catch { /* Offline: media stays until a later activation can list it. */ }
    if (full) {
      const retained = assetPaths([full, previousManifest]);
      for (const request of await runtime.keys()) {
        const path = cacheKey(request.url);
        if (MEDIA.test(new URL(path).pathname) && !retained.has(path)) await runtime.delete(request);
      }
    }
    const source = full || current;
    const paths = new Set();
    const visited = new Set();
    const add = (path, extension) => {
      const url = new URL(path, self.location.origin);
      if (sameOrigin(url) && url.pathname.startsWith('/assets/') && extension.test(url.pathname)) paths.add(cacheKey(url));
    };
    const collect = key => {
      if (visited.has(key)) return;
      visited.add(key);
      const entry = source[key];
      if (!entry) return;
      if (entry.file) add(entry.file, /\.m?js$/i);
      for (const path of entry.css || []) add(path, /\.css$/i);
      // World texts (assets/<loc>-texts-*.json) are fetched by the pack: refresh them with its images.
      for (const path of entry.assets || []) add(path, /\.(?:webp|json)$/i);
      for (const imported of entry.imports || []) collect(imported);
    };
    for (const key of visitedPacks) collect(key);
    for (const path of paths) {
      try {
        if (await runtime.match(path)) continue;
        const response = await fetch(localRequest(path));
        if (accepted(response)) await runtime.put(path, response);
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
  if (!navigation && !PRECACHE.includes(url.pathname) && !url.pathname.startsWith('/assets/') && !ambience(url.pathname)) return;
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
        const cache = url.pathname.startsWith('/assets/') || ambience(url.pathname) ? runtime : shell;
        try { await cache.put(cacheKey(url), response.clone()); } catch { /* Return the network response even if caching fails. */ }
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
