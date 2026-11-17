/**
 * Düşük seviye görüntü işleme yardımcıları (saf JavaScript, typed array tabanlı).
 * Web Worker içinde ve Node testlerinde DOM olmadan çalışır.
 *
 * Görüntü: { data: Uint8ClampedArray(RGBA), width, height }
 * Gri görüntü: { data: Uint8Array, width, height }
 */

export function toGray(img) {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/** RGBA görüntüden dikdörtgen kırpar (sınırları güvenli). */
export function cropRGBA(img, rect) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h, offsetX: x0, offsetY: y0 };
}

/** Çift doğrusal (bilinear) yeniden boyutlandırma — gri görüntü. */
export function resizeGray(g, nw, nh) {
  const out = new Uint8Array(nw * nh);
  const sx = g.width / nw;
  const sy = g.height / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(g.height - 1, Math.floor(fy));
    const y1 = Math.min(g.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(g.width - 1, Math.floor(fx));
      const x1 = Math.min(g.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = g.data[y0 * g.width + x0];
      const b = g.data[y0 * g.width + x1];
      const c = g.data[y1 * g.width + x0];
      const d = g.data[y1 * g.width + x1];
      out[y * nw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** Yatay gradyan büyüklüğü (Sobel-X). Plaka karakterleri güçlü dikey kenar üretir. */
export function sobelX(g) {
  const { data, width: w, height: h } = g;
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -data[i - w - 1] - 2 * data[i - 1] - data[i + w - 1] +
        data[i - w + 1] + 2 * data[i + 1] + data[i + w + 1];
      const v = Math.abs(gx) >> 2;
      out[i] = v > 255 ? 255 : v;
    }
  }
  return { data: out, width: w, height: h };
}

export function histogram(arr) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
  return hist;
}

/** Otsu eşik değeri */
export function otsu(arr) {
  const hist = histogram(arr);
  const total = arr.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

export function meanStd(arr) {
  let s = 0, s2 = 0;
  for (let i = 0; i < arr.length; i++) { s += arr[i]; s2 += arr[i] * arr[i]; }
  const m = s / arr.length;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / arr.length - m * m)) };
}

/** Laplace varyansı — netlik (bulanıklık) ölçüsü. Yüksek = net. */
export function laplacianVariance(g) {
  const { data, width: w, height: h } = g;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      s += v; s2 += v * v; n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/** İkili görüntüde yatay genişletme (dilate) — kayan pencere toplamı ile O(n). */
function dilateH(bin, w, h, k) {
  const out = new Uint8Array(bin.length);
  const r = k >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = -r; x < w + r; x++) {
      const add = x + r;
      if (add < w && add >= 0) count += bin[row + add];
      const rem = x - r - 1;
      if (rem >= 0 && rem < w) count -= bin[row + rem];
      if (x >= 0 && x < w) out[row + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function dilateV(bin, w, h, k) {
  const out = new Uint8Array(bin.length);
  const r = k >> 1;
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h + r; y++) {
      const add = y + r;
      if (add < h && add >= 0) count += bin[add * w + x];
      const rem = y - r - 1;
      if (rem >= 0 && rem < h) count -= bin[rem * w + x];
      if (y >= 0 && y < h) out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function erodeV(bin, w, h, k) {
  // erode = not(dilate(not))
  const inv = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) inv[i] = bin[i] ? 0 : 1;
  const d = dilateV(inv, w, h, k);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

export function morphCloseH(bin, w, h, k) {
  return erodeHSafe(dilateH(bin, w, h, k), w, h, k);
}

/** Kenar etkisini sıfırlamadan erozyon (kenarlar 1 kabul edilir) */
function erodeHSafe(bin, w, h, k) {
  const inv = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) inv[i] = bin[i] ? 0 : 1;
  const d = dilateH(inv, w, h, k);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

export function morphOpenV(bin, w, h, k) {
  return dilateV(erodeV(bin, w, h, k), w, h, k);
}

export function morphOpenH(bin, w, h, k) {
  return dilateH(erodeHSafe(bin, w, h, k), w, h, k);
}

export { dilateH, erodeHSafe as erodeH, dilateV, erodeV };

/**
 * 8-komşuluklu bağlı bileşen etiketleme. Her bileşen için sınır kutusu ve piksel sayısı döner.
 */
export function connectedComponents(bin, w, h, minPixels = 20) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let label = 0;
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || labels[i]) continue;
    label++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    while (sp) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p - px) / w;
      count++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (bin[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
        }
      }
    }
    if (count >= minPixels) {
      comps.push({ label, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count });
    }
  }
  comps.labels = labels; // piksel → etiket haritası
  return comps;
}

/** Gri görüntüden alt bölge */
export function cropGray(g, r) {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(g.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(g.height, Math.ceil(r.y + r.h));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w);
  return { data: out, width: w, height: h };
}

/** Kutular için Non-Maximum Suppression */
export function nms(boxes, iouThr = 0.4) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of sorted) {
    let ok = true;
    for (const k of keep) {
      const x1 = Math.max(b.x, k.x), y1 = Math.max(b.y, k.y);
      const x2 = Math.min(b.x + b.w, k.x + k.w), y2 = Math.min(b.y + b.h, k.y + k.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const u = b.w * b.h + k.w * k.h - inter;
      if (u > 0 && inter / u > iouThr) { ok = false; break; }
      // tamamen içerilen küçük kutuyu da bastır
      if (inter > 0.85 * Math.min(b.w * b.h, k.w * k.h)) { ok = false; break; }
    }
    if (ok) keep.push(b);
  }
  return keep;
}
