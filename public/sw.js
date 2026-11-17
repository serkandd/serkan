/**
 * Service Worker
 *  - Uygulama kabuğu, kütüphaneler ve YZ modelleri önbelleğe alınır → internet yokken de çalışır.
 *  - Yanıtlara COOP/COEP başlıkları eklenir → crossOriginIsolated = true → SharedArrayBuffer ile
 *    çok iş parçacıklı WASM (ONNX Runtime) kullanılabilir. Statik barındırma (GitHub Pages vb.)
 *    özel başlık desteklemese bile bu yöntem çalışır.
 */
const CACHE_PREFIX = 'ga-';
let CACHE = `${CACHE_PREFIX}v1`;

async function precache() {
  const res = await fetch('precache-manifest.json', { cache: 'no-store' });
  const manifest = await res.json();
  CACHE = `${CACHE_PREFIX}${manifest.version}`;
  const cache = await caches.open(CACHE);
  const files = ['./', ...manifest.files];
  // Tek tek ekle: bir dosya başarısız olsa da diğerleri önbelleğe girsin
  await Promise.all(files.map(async (f) => {
    try {
      const r = await fetch(f, { cache: 'reload' });
      if (r.ok) await cache.put(f, r);
    } catch { /* çevrimdışı kurulum */ }
  }));
  return CACHE;
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const current = keys.filter((k) => k.startsWith(CACHE_PREFIX)).sort().pop();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== current).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function withIsolation(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const LONG_LIVED = /\/(vendor|models)\//;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'HEAD') {
    e.respondWith((async () => {
      try { return await fetch(req); } catch {
        const c = await caches.match(req.url, { ignoreMethod: true, ignoreSearch: true });
        return c ? new Response(null, { status: 200, headers: c.headers }) : new Response(null, { status: 404 });
      }
    })());
    return;
  }
  if (req.method !== 'GET') return;

  e.respondWith((async () => {
    const cache = await caches.open((await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX)).sort().pop() || CACHE);
    if (LONG_LIVED.test(url.pathname)) {
      // Büyük ve değişmeyen dosyalar: önce önbellek
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return withIsolation(hit);
      try {
        const r = await fetch(req);
        if (r.ok) cache.put(req, r.clone());
        return withIsolation(r);
      } catch {
        return new Response('Çevrimdışı: dosya önbellekte yok', { status: 503 });
      }
    }
    // Uygulama kodu: önce ağ (güncellemeler hemen gelsin), yoksa önbellek
    try {
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return withIsolation(r);
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : null);
      return hit ? withIsolation(hit) : new Response('Çevrimdışı', { status: 503 });
    }
  })());
});
