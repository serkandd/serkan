/**
 * Plaka kırpıntısını OCR için hazırlar (saf JavaScript; worker ve Node uyumlu).
 *
 *  - Soldaki mavi "TR" bandını tespit edip kırpar
 *  - Gri tonlama, kontrast germe, OCR için uygun yüksekliğe ölçekleme
 *  - Otsu ikilileştirme; koyu zemin/açık yazı ise tersine çevirme
 *  - Kenar çerçevesini ve kenara değen lekeleri temizleme
 *  - Etrafına beyaz kenar boşluğu ekleme (Tesseract için önemlidir)
 *  - Kalite ölçümü: netlik (Laplace varyansı), boyut, kontrast
 */
import { toGray, resizeGray, otsu, meanStd, laplacianVariance, connectedComponents } from '../vision/imgproc.js';

/** RGBA kırpıntıda soldaki mavi bandın bittiği x konumunu bulur (yoksa 0). */
export function findBlueBandEnd(rgba) {
  const { data, width: w, height: h } = rgba;
  const maxScan = Math.floor(w * 0.22);
  let lastBlueCol = -1;
  for (let x = 0; x < maxScan; x++) {
    let blue = 0;
    for (let y = Math.floor(h * 0.15); y < Math.ceil(h * 0.85); y++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (b > 90 && b > r + 35 && b > g + 15) blue++;
    }
    if (blue > h * 0.35) lastBlueCol = x;
    else if (lastBlueCol >= 0 && x > lastBlueCol + 3) break;
  }
  return lastBlueCol >= 0 ? lastBlueCol + 2 : 0;
}

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} rgba plaka kırpıntısı
 * @param {object} [opts]
 * @param {number} [opts.targetHeight=72]
 * @returns {{image:{data:Uint8ClampedArray,width,height}, quality:{sharpness,contrast,width,height,ok,reason}}}
 */
export function preprocessPlate(rgba, opts = {}) {
  const targetHeight = opts.targetHeight ?? 72;
  const bandEnd = findBlueBandEnd(rgba);
  let gray = toGray(rgba);
  if (bandEnd > 0 && bandEnd < gray.width * 0.3) {
    const nw = gray.width - bandEnd;
    const out = new Uint8Array(nw * gray.height);
    for (let y = 0; y < gray.height; y++) {
      out.set(gray.data.subarray(y * gray.width + bandEnd, (y + 1) * gray.width), y * nw);
    }
    gray = { data: out, width: nw, height: gray.height };
  }

  const srcW = gray.width, srcH = gray.height;
  const sharpness = laplacianVariance(gray);
  const { std } = meanStd(gray.data);

  // Ölçekle
  const scale = targetHeight / gray.height;
  const nw = Math.max(32, Math.round(gray.width * scale));
  let g = resizeGray(gray, nw, targetHeight);

  // Kontrast germe (yüzde 2 - 98)
  const sorted = Uint8Array.from(g.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < g.data.length; i++) {
    const v = ((g.data[i] - lo) * 255) / range;
    g.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  const t = otsu(g.data);
  let bin = new Uint8Array(g.data.length); // 1 = yazı (koyu)
  let dark = 0;
  for (let i = 0; i < bin.length; i++) {
    bin[i] = g.data[i] <= t ? 1 : 0;
    dark += bin[i];
  }
  // Koyu zemin açık yazı (ör. bazı özel plakalar) → ters çevir
  if (dark > bin.length * 0.6) {
    for (let i = 0; i < bin.length; i++) bin[i] = bin[i] ? 0 : 1;
  }

  // Kenara değen ya da karakter boyutuna uymayan bileşenleri sil (çerçeve, vida, gölge)
  const comps = connectedComponents(bin, nw, targetHeight, 1);
  const keepLabels = new Set();
  let charLike = 0;
  for (const c of comps) {
    const touches = c.y <= 1 || c.y + c.h >= targetHeight - 1;
    const tooWide = c.w > nw * 0.35;
    const tooSmall = c.h < targetHeight * 0.3 || c.count < 12;
    const tooTall = c.h > targetHeight * 0.95;
    if (!touches && !tooWide && !tooSmall && !tooTall) {
      keepLabels.add(c.label);
      charLike++;
    }
  }
  const cleaned = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) if (bin[i] && keepLabels.has(comps.labels[i])) cleaned[i] = 1;

  // Beyaz zemin üzerine siyah yazı, kenar boşluklu RGBA çıktı
  const pad = 12;
  const ow = nw + pad * 2, oh = targetHeight + pad * 2;
  const out = new Uint8ClampedArray(ow * oh * 4).fill(255);
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < nw; x++) {
      if (cleaned[y * nw + x]) {
        const o = ((y + pad) * ow + (x + pad)) * 4;
        out[o] = out[o + 1] = out[o + 2] = 0;
      }
    }
  }

  let reason = '';
  if (srcW < 40 || srcH < 10) reason = 'Plaka görüntüde çok küçük';
  else if (sharpness < 40) reason = 'Görüntü bulanık';
  else if (std < 20) reason = 'Kontrast yetersiz';
  else if (charLike < 4) reason = 'Karakterler ayırt edilemiyor';

  return {
    image: { data: out, width: ow, height: oh },
    quality: { sharpness, contrast: std, width: srcW, height: srcH, charCount: charLike, ok: !reason, reason },
  };
}
