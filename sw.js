// Service Worker: cache the whole app (HTML/JS/WASM/models) on install so
// the PWA starts offline after the first download (SPEC section 2).
//
// Update strategy (fixed 2026-11-04: phones kept serving the old layout
// forever because the cache name was a constant and this file was copied
// verbatim, so its bytes never changed and the browser never saw an SW
// update):
//   - build.mjs stamps content hashes into 668276c34ccc / bd980c22b59a
//     below, so ANY change to the app files (or the models) changes this
//     file's bytes and the cache names. The browser then installs the new
//     SW, precaches into the new caches, and activate() drops old caches.
//   - App assets and models live in separate caches: a layout-only change
//     bumps APP_VER only, so phones do not re-download ~90MB of models.
//   - skipWaiting + clients.claim (already used before) make the new SW
//     take over immediately; main.js reloads the page once on
//     controllerchange so the new layout appears without manual reopen.
//   - Navigations are network-first (fall back to cache when offline), so
//     the HTML shell itself can never get stuck on a stale copy.
const APP_VER = '668276c34ccc';
const MODEL_VER = 'bd980c22b59a';
const APP_CACHE = 'mahjong-local-app-' + APP_VER;
const MODEL_CACHE = 'mahjong-local-models-' + MODEL_VER;
const APP_ASSETS = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './js/main.bundle.js', './ai_baseline.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './assets/mortal_wasm.js', './assets/mortal_wasm_bg.wasm',
  './ort/ort-wasm-simd-threaded.wasm', './ort/ort-wasm-simd-threaded.mjs',
  './ort/ort-wasm-simd-threaded.jsep.wasm', './ort/ort-wasm-simd-threaded.jsep.mjs',
];
const MODEL_ASSETS = [
  './models/jaklab_v1.onnx',
  './models/jaklab_v1_light.onnx',   // CPU 六段相当以下（2026-11-06 実施順2）
];
const AUDIO_ASSETS = ["./assets/9c41b7e20a6f.bin","./assets/bd7298a1cf04.bin","./assets/04fa8c9d71be.bin","./assets/e138b2a690cd.bin","./assets/7a4dc019e2b8.bin","./assets/c5803f6b2d91.bin","./assets/2f89a64ed031.bin"]; // build injects opaque asset paths
self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([
    caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS)),
    caches.open(MODEL_CACHE).then(c => c.addAll(MODEL_ASSETS)),
    // Optional audio must never prevent the game from installing/updating.
    caches.open(APP_CACHE).then(c => Promise.all(AUDIO_ASSETS.map(url =>
      c.add(url).catch(() => console.warn('[audio] optional precache failed'))))),
  ]).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(
      keys.filter(k => k !== APP_CACHE && k !== MODEL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
async function cacheMatch(request) {
  for (const name of [APP_CACHE, MODEL_CACHE]) {
    const c = await caches.open(name);
    const hit = await c.match(request);
    if (hit) return hit;
  }
  return undefined;
}
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // version.json is the build marker: never serve it from cache.
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Navigations: network-first so a new HTML shell is picked up as soon as
  // the device is online; fall back to the precached shell when offline.
  if (e.request.mode === 'navigate' ||
      url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        // Only a good response may replace the offline shell (a 404/500
        // page cached here would be served when the device goes offline).
        if (fresh.ok) {
          const c = await caches.open(APP_CACHE);
          c.put('./index.html', fresh.clone());
        }
        return fresh;
      } catch (_) {
        return (await cacheMatch('./index.html')) || (await cacheMatch(e.request));
      }
    })());
    return;
  }
  // Static assets: cache-first (cache names are content-versioned, so a
  // hit here is by construction the current build's file).
  e.respondWith((async () => {
    const hit = await cacheMatch(e.request);
    if (hit) return hit;
    const fresh = await fetch(e.request);
    // Never cache error responses: cache-first would pin them for the
    // lifetime of this build's cache.
    if (fresh.ok) {
      const c = await caches.open(APP_CACHE);
      c.put(e.request, fresh.clone());
    }
    return fresh;
  })());
});
