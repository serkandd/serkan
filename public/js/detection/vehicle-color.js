/**
 * Araç rengi tahmini (saf JavaScript, model gerektirmez).
 * Araç gövdesinden (cam, tekerlek ve plaka dışı orta bant) alınan piksellerin HSV dağılımına bakar.
 */

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function chromaticName(h, s, v) {
  if (h >= 10 && h < 45 && v < 0.55) return 'Kahverengi';
  if (h < 12 || h >= 340) return v < 0.45 ? 'Bordo' : 'Kırmızı';
  if (h < 40) return 'Turuncu';
  if (h < 70) return v > 0.6 && s < 0.45 ? 'Bej' : 'Sarı';
  if (h < 170) return 'Yeşil';
  if (h < 255) return v < 0.42 ? 'Lacivert' : 'Mavi';
  if (h < 300) return 'Mor';
  return 'Pembe';
}

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img araç görüntüsü (RGBA)
 * @param {{x,y,w,h}} [exclude] hariç tutulacak bölge (plaka), görüntü koordinatında
 * @returns {{name:string, confidence:number}}
 */
export function estimateVehicleColor(img, exclude = null) {
  const { data, width: W, height: H } = img;
  const counts = new Map();
  let total = 0, chromatic = 0;
  const y0 = Math.floor(H * 0.42), y1 = Math.floor(H * 0.8);
  const x0 = Math.floor(W * 0.12), x1 = Math.floor(W * 0.88);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      if (exclude && x >= exclude.x && x < exclude.x + exclude.w && y >= exclude.y && y < exclude.y + exclude.h) continue;
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      let name;
      if (v < 0.2) name = 'Siyah';
      else if (s < 0.2 || (s < 0.3 && v > 0.8)) name = v > 0.72 ? 'Beyaz' : v < 0.32 ? 'Siyah' : 'Gri/Gümüş';
      else { name = chromaticName(h, s, v); chromatic++; }
      counts.set(name, (counts.get(name) || 0) + 1);
      total++;
    }
  }
  if (!total) return { name: '', confidence: 0 };
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Renkli pikseller belirgin bir paya sahipse renk adı, değilse akromatik çoğunluk
  let best = sorted[0];
  if (chromatic / total > 0.28) {
    best = sorted.find(([n]) => !['Siyah', 'Beyaz', 'Gri/Gümüş'].includes(n)) || best;
  }
  return { name: best[0], confidence: best[1] / total };
}
