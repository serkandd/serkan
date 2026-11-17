/**
 * Plaka analiz Web Worker'ı.
 *
 * Ana iş parçacığını (UI) bloklamamak için piksel düzeyindeki tüm ağır işlemler burada yapılır:
 *   - Kare bitmap'inin OffscreenCanvas'a çizilmesi
 *   - Araç bölgeleri (ROI) veya tüm karede plaka adayı arama
 *   - Her aday için OCR'a hazır ikili görüntü üretimi (PNG Blob) ve kalite ölçümü
 *   - Olay kaydı için küçük renkli plaka küçük resmi (JPEG Blob)
 *
 * Mesaj protokolü:
 *   → {type:'analyze', id, bitmap:ImageBitmap, rois:[{x,y,w,h}]|null, fullFrame:boolean, maxFullWidth}
 *   ← {type:'result', id, plates:[{box,score,quality,ocrBlob,thumbBlob}], ms}
 *   ← {type:'error', id, message}
 */
import { localizePlates } from '../detection/plate-localizer.js';
import { preprocessPlate } from '../ocr/plate-preprocess.js';
import { nms } from '../vision/imgproc.js';

let canvas = null;
let ctx = null;

function ensureCanvas(w, h) {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
}

/** Bir bölgeyi istenen en büyük genişliğe ölçekleyerek RGBA olarak okur */
function readRegion(region, maxWidth) {
  const scale = Math.min(1, maxWidth / region.w);
  const w = Math.max(8, Math.round(region.w * scale));
  const h = Math.max(8, Math.round(region.h * scale));
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(canvas, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const img = cx.getImageData(0, 0, w, h);
  return { img, scale };
}

async function encode(rgba, type, quality) {
  const c = new OffscreenCanvas(rgba.width, rgba.height);
  const cx = c.getContext('2d');
  cx.putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  return c.convertToBlob({ type, quality });
}

async function analyze(msg) {
  const t0 = performance.now();
  const { bitmap } = msg;
  ensureCanvas(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const W = canvas.width, H = canvas.height;
  const regions = [];
  if (msg.rois?.length) {
    for (const r of msg.rois) {
      // Araç kutusunu biraz genişlet; plakalar genelde aracın alt yarısındadır
      const x = Math.max(0, r.x - r.w * 0.05);
      const y = Math.max(0, r.y + r.h * 0.25);
      const w = Math.min(W - x, r.w * 1.1);
      const h = Math.min(H - y, r.h * 0.8);
      if (w > 24 && h > 12) regions.push({ x, y, w, h, maxWidth: 720 });
    }
  }
  if (msg.fullFrame || !regions.length) {
    regions.push({ x: 0, y: 0, w: W, h: H, maxWidth: msg.maxFullWidth ?? 1024 });
  }

  let found = [];
  for (const region of regions) {
    const { img, scale } = readRegion(region, region.maxWidth);
    const cands = localizePlates(img, { maxCandidates: 5, minWidth: 26 });
    for (const c of cands) {
      found.push({
        x: region.x + c.x / scale,
        y: region.y + c.y / scale,
        w: c.w / scale,
        h: c.h / scale,
        score: c.score,
      });
    }
  }
  found = nms(found, 0.3).slice(0, 6);

  const plates = [];
  for (const box of found) {
    // OCR için tam çözünürlükten kırp; küçük plakaları büyüt (preprocess içinde)
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.min(W - x, Math.ceil(box.w)), h = Math.min(H - y, Math.ceil(box.h));
    if (w < 8 || h < 4) continue;
    const crop = ctx.getImageData(x, y, w, h);
    const { image, quality } = preprocessPlate(crop, { targetHeight: 72 });
    const [ocrBlob, thumbBlob] = await Promise.all([
      quality.ok ? encode(image, 'image/png') : Promise.resolve(null),
      encode(crop, 'image/jpeg', 0.8),
    ]);
    plates.push({ box: { x, y, w, h }, score: box.score, quality, ocrBlob, thumbBlob });
  }
  return { plates, ms: performance.now() - t0 };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  try {
    const res = await analyze(msg);
    self.postMessage({ type: 'result', id: msg.id, ...res });
  } catch (err) {
    try { msg.bitmap?.close?.(); } catch { /* yok say */ }
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
