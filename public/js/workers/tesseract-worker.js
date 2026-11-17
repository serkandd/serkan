/**
 * Tesseract.js worker sarmalayıcısı. Dil verisi ".wasm" ekiyle saklanır (Android paketleyicisi ve
 * bazı barındırma servisleri .gz uzantısını sunmaz); önce bu ad, olmazsa özgün ad denenir.
 */
const nativeFetch = self.fetch.bind(self);
const isLang = (u) => /\.traineddata(\.gz)?$/.test(u);
self.fetch = async (url, opts) => {
  const u = String(url);
  if (!isLang(u)) return nativeFetch(url, opts);
  try {
    const r = await nativeFetch(`${u}.wasm`, opts);
    if (r.ok && !(r.headers.get('content-type') || '').includes('text/html')) return r;
  } catch { /* özgün adı dene */ }
  return nativeFetch(u, opts);
};
importScripts('../../vendor/tesseract/worker.min.js');
