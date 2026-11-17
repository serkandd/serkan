/**
 * İkili model dosyası indirir. Bazı barındırma ortamları (.bin/.onnx/.gz) uzantılarını sunmaz;
 * bu durumda aynı dosya ".wasm" ekiyle yayınlanır ve otomatik olarak o ad denenir.
 */
export async function fetchBinary(url) {
  for (const u of [url, `${url}.wasm`]) {
    try {
      const r = await fetch(u);
      const type = r.headers.get('content-type') || '';
      if (r.ok && !type.includes('text/html')) return new Uint8Array(await r.arrayBuffer());
    } catch { /* sonraki adı dene */ }
  }
  throw new Error(`Dosya indirilemedi: ${url.split('/').pop()}`);
}
