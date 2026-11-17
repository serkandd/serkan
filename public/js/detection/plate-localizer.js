/**
 * Modelsiz (klasik bilgisayarlı görü) plaka bölgesi bulucu.
 *
 * YOLO plaka modeli yüklenmediğinde de sistemin çalışmasını sağlar; model varken
 * ikinci bir doğrulayıcı olarak da kullanılabilir.
 *
 * Yöntem:
 *  1. Gri tonlama → Sobel-X (karakterler yoğun dikey kenar üretir)
 *  2. Adaptif eşik → yatay morfolojik kapama (karakterleri tek bloğa birleştirir)
 *  3. Bağlı bileşenler → en-boy oranı, doluluk, boyut filtresi
 *  4. Aday doğrulama: kutu içinde Otsu ikilileştirme, satır boyunca geçiş sayısı
 *     (7-8 karakter ≈ 12+ geçiş), açık zemin oranı, kontrast
 *
 * Bu adım yalnızca "aday" üretir. Kesin plaka kararı, OCR + Türk plaka formatı
 * doğrulaması + çok-kareli oylama ile verilir; böylece tabela/yazı gibi yanlış
 * adaylar sonuç üretmez.
 */
import {
  toGray, sobelX, otsu, meanStd, morphCloseH, morphOpenV, morphOpenH,
  connectedComponents, cropGray, nms, resizeGray,
} from '../vision/imgproc.js';

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img RGBA görüntü
 * @param {object} [opts]
 * @param {number} [opts.maxCandidates=6]
 * @param {number} [opts.minWidth=28] İşleme ölçeğinde en küçük plaka genişliği (px)
 * @returns {Array<{x,y,w,h,score}>} görüntü koordinatında aday kutular
 */
export function localizePlates(img, opts = {}) {
  const maxCandidates = opts.maxCandidates ?? 6;
  const gray = img.data.length === img.width * img.height ? img : toGray(img);
  return localizeGray(gray, { ...opts, maxCandidates });
}

export function localizeGray(gray, opts = {}) {
  const { width: w, height: h } = gray;
  const minWidth = opts.minWidth ?? 28;
  const maxCandidates = opts.maxCandidates ?? 6;

  const edges = sobelX(gray);
  const { mean, std } = meanStd(edges.data);
  const thr = Math.max(24, Math.min(140, mean + 1.6 * std));
  let bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = edges.data[i] > thr ? 1 : 0;

  // Karakterler arası boşluğu kapat: kernel ≈ beklenen karakter aralığı
  const kClose = Math.max(7, Math.round(Math.min(w, 1280) / 55));
  bin = morphCloseH(bin, w, h, kClose);
  bin = morphOpenV(bin, w, h, 3); // ince yatay çizgileri temizle
  bin = morphOpenH(bin, w, h, 5); // tekil gürültüyü temizle

  const comps = mergeRow(connectedComponents(bin, w, h, 40), h);
  const cands = [];
  for (const c of comps) {
    if (c.w < minWidth || c.h < 7) continue;
    if (c.h > h * 0.4 || c.w > w * 0.9) continue;
    const ar = c.w / c.h;
    if (ar < 1.8 || ar > 12) continue; // yalnızca karakter bandı da olabilir (TR plakada ≈ 7-10)
    const fill = c.count / (c.w * c.h);
    if (fill < 0.35) continue;

    // Plaka çerçevesinin tamamını almak için hafif genişlet
    const padX = c.w * 0.08;
    const padY = c.h * 0.25;
    const box = {
      x: Math.max(0, c.x - padX),
      y: Math.max(0, c.y - padY),
      w: Math.min(w, c.x + c.w + padX) - Math.max(0, c.x - padX),
      h: Math.min(h, c.y + c.h + padY) - Math.max(0, c.y - padY),
    };
    const v = verifyCandidate(gray, box);
    if (v.score <= 0.25) continue;
    const arScore = 1 - Math.min(1, Math.abs(ar - 5.5) / 6);
    const score = Math.min(1, 0.6 * v.score + 0.25 * arScore + 0.15 * Math.min(1, fill));
    cands.push({ ...box, score, transitions: v.transitions });
  }
  return nms(cands, 0.3).slice(0, maxCandidates);
}

/**
 * Aynı satırda yan yana duran parçaları birleştirir. Plakada il kodu, harf ve rakam grupları
 * arasında boşluk olduğundan kapama işlemi bunları ayrı bloklar olarak bırakabilir.
 */
function mergeRow(comps, H) {
  const items = comps
    .filter((c) => c.h >= 6 && c.h < H * 0.4)
    .map((c) => ({ ...c, parts: 1 }))
    .sort((a, b) => a.x - b.x);
  const merged = [];
  const used = new Array(items.length).fill(false);
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    let cur = { ...items[i] };
    used[i] = true;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < items.length; j++) {
        if (used[j]) continue;
        const c = items[j];
        const gap = c.x - (cur.x + cur.w);
        if (gap < -cur.w * 0.2 || gap > Math.max(cur.h, c.h) * 1.3) continue;
        const top = Math.max(cur.y, c.y), bot = Math.min(cur.y + cur.h, c.y + c.h);
        const vOverlap = (bot - top) / Math.min(cur.h, c.h);
        const hr = Math.max(cur.h, c.h) / Math.min(cur.h, c.h);
        if (vOverlap < 0.6 || hr > 1.6) continue;
        const x1 = Math.min(cur.x, c.x), y1 = Math.min(cur.y, c.y);
        const x2 = Math.max(cur.x + cur.w, c.x + c.w), y2 = Math.max(cur.y + cur.h, c.y + c.h);
        cur = { ...cur, x: x1, y: y1, w: x2 - x1, h: y2 - y1, count: cur.count + c.count, parts: cur.parts + c.parts };
        used[j] = true;
        grew = true;
      }
    }
    merged.push(cur);
    // Parçaların tekil hâllerini de aday olarak tut (birleştirme yanlışsa)
    if (cur.parts > 1) for (let k = 0; k < items.length; k++) if (k === i) merged.push(items[k]);
  }
  return merged;
}

/**
 * Aday kutunun plaka olma olasılığını puanlar (0-1).
 */
export function verifyCandidate(gray, box) {
  const roi = cropGray(gray, box);
  if (roi.width < 16 || roi.height < 6) return { score: 0, transitions: 0 };
  // Karşılaştırılabilirlik için sabit yüksekliğe ölçekle
  const nh = 40;
  const nw = Math.max(40, Math.min(400, Math.round((roi.width * nh) / roi.height)));
  const r = resizeGray(roi, nw, nh);
  const t = otsu(r.data);
  const { std } = meanStd(r.data);
  if (std < 18) return { score: 0, transitions: 0 }; // düz yüzey

  let bright = 0;
  for (let i = 0; i < r.data.length; i++) if (r.data[i] > t) bright++;
  const brightRatio = bright / r.data.length;

  // Orta bantta satır başına siyah/beyaz geçiş sayısı
  let transSum = 0;
  const rows = [0.38, 0.5, 0.62];
  for (const fr of rows) {
    const y = Math.round(nh * fr);
    let prev = r.data[y * nw] > t;
    let n = 0;
    for (let x = 1; x < nw; x++) {
      const cur = r.data[y * nw + x] > t;
      if (cur !== prev) n++;
      prev = cur;
    }
    transSum += n;
  }
  const transitions = transSum / rows.length;

  // Beyaz zemin + koyu karakter (TR standart) → parlak oranı 0.45-0.85
  const brightScore = brightRatio > 0.4 && brightRatio < 0.9 ? 1 : brightRatio > 0.25 ? 0.5 : 0.1;
  const transScore = transitions < 6 ? 0 : transitions > 40 ? 0.3 : Math.min(1, (transitions - 6) / 8);
  const contrastScore = Math.min(1, std / 60);
  const score = transScore * 0.5 + brightScore * 0.3 + contrastScore * 0.2;
  return { score: transScore === 0 ? 0 : score, transitions, brightRatio };
}
