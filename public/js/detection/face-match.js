/**
 * Yüz şablonu (128 boyutlu tanımlayıcı) eşleştirme — saf JavaScript.
 *
 * Kimlik doğrulama YALNIZCA kayıtlı ve hukuken izinli personel şablonlarına karşı yapılır.
 * Eşik altında kalan veya belirsiz (iki kişiye yakın) sonuçlar "eşleşme yok" kabul edilir;
 * kayıtlı olmayan kişilere asla isim atanmaz.
 */

export function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Mesafeyi kullanıcıya gösterilecek 0-100 benzerlik skoruna çevirir (yaklaşık). */
export function distanceToScore(distance) {
  // face-api 128B: ~0.35 çok benzer, 0.6 genel eşik. 0.25 → %100, 0.65 → %0
  const s = 1 - (distance - 0.25) / 0.4;
  return Math.round(Math.max(0, Math.min(1, s)) * 100);
}

/**
 * @param {Float32Array|number[]} descriptor canlı görüntüden çıkarılan şablon
 * @param {Array<{id, fullName, employeeNo, status, descriptors:number[][]}>} people
 * @param {{threshold:number, margin:number}} opts
 * @returns {{matched:boolean, person?:object, distance:number, secondDistance:number, reason?:string}}
 */
export function matchFace(descriptor, people, { threshold = 0.45, margin = 0.06 } = {}) {
  let best = { distance: Infinity, person: null };
  let second = { distance: Infinity, person: null };
  for (const p of people) {
    if (!p.descriptors?.length) continue;
    // Kişinin birden fazla şablonu varsa en yakını kullanılır
    let d = Infinity;
    for (const t of p.descriptors) d = Math.min(d, euclidean(descriptor, t));
    if (d < best.distance) {
      second = best;
      best = { distance: d, person: p };
    } else if (d < second.distance) {
      second = { distance: d, person: p };
    }
  }
  if (!best.person) return { matched: false, distance: Infinity, secondDistance: Infinity, reason: 'Kayıtlı şablon yok' };
  if (best.distance > threshold) {
    return { matched: false, distance: best.distance, secondDistance: second.distance, reason: 'Kayıtlı kişilerle eşleşmedi' };
  }
  if (second.person && second.distance - best.distance < margin) {
    return { matched: false, distance: best.distance, secondDistance: second.distance, reason: 'Belirsiz eşleşme' };
  }
  return { matched: true, person: best.person, distance: best.distance, secondDistance: second.distance };
}

/** 68 nokta yüz işaretlerinden yaklaşık önden bakış (frontallik) skoru: 1 = tam önden */
export function frontalScore(points) {
  if (!points || points.length < 68) return 0;
  const nose = points[30];
  const jawL = points[0];
  const jawR = points[16];
  const dl = Math.hypot(nose.x - jawL.x, nose.y - jawL.y);
  const dr = Math.hypot(nose.x - jawR.x, nose.y - jawR.y);
  const yaw = Math.abs(dl - dr) / Math.max(1e-6, dl + dr); // 0 = simetrik
  const eyeL = points[36], eyeR = points[45];
  const roll = Math.abs(Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x)); // radyan
  // Baş yana eğikliği (roll) tanıma modelinde hizalama ile telafi edilir; yalnızca aşırı eğiklik cezalandırılır
  const rollPenalty = roll < 0.45 ? 1 : Math.max(0, 1 - (roll - 0.45) / 0.5);
  // yaw oranı ≈0.1 → ~10°, ≈0.35 → ~30°, ≥0.6 → profil
  return Math.max(0, Math.min(1, 1 - Math.max(0, yaw - 0.1) * 2)) * rollPenalty;
}
