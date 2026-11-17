/**
 * Tesseract.js worker sarmalayıcısı. Dil verisi (.traineddata.gz) sunulmayan barındırma
 * ortamlarında aynı dosyanın ".wasm" ekli adını dener; ardından asıl worker'ı yükler.
 */
const nativeFetch = self.fetch.bind(self);
const isLang = (u) => /\.traineddata(\.gz)?$/.test(u);
self.fetch = async (url, opts) => {
  const u = String(url);
  try {
    const r = await nativeFetch(u, opts);
    if (!isLang(u) || (r.ok && !(r.headers.get('content-type') || '').includes('text/html'))) return r;
  } catch (e) {
    if (!isLang(u)) throw e;
  }
  return nativeFetch(`${u}.wasm`, opts);
};
importScripts('../../vendor/tesseract/worker.min.js');
