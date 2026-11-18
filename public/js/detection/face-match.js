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

export function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}

/** ArcFace kosinüs benzerliğini 0-100 güven skoruna çevirir (0.30 → 0, 0.65 → 100) */
export function similarityToScore(sim) {
  return Math.round(Math.max(0, Math.min(1, (sim - 0.3) / 0.35)) * 100);
}

/**
 * Canlı şablonu kayıtlı personelle karşılaştırır.
 *  - 512B (ArcFace) şablonlar kosinüs benzerliği ile, eski 128B şablonlar Öklid mesafesiyle karşılaştırılır;
 *    farklı türdeki şablonlar birbirine karıştırılmaz.
 *  - Kişi başına birden çok şablon varsa en iyi iki benzerliğin ortalaması kullanılır (tek şanslı
 *    eşleşmeye karşı dayanıklı); tek şablon varsa doğrudan o.
 *
 * @returns {{matched:boolean, person?:object, score:number, similarity?:number, distance?:number, reason?:string}}
 */
export function matchFace(descriptor, people, opts = {}) {
  const D = descriptor.length;
  const arc = D === 512;
  const thr = arc ? (opts.simThreshold ?? 0.42) : (opts.threshold ?? 0.45);
  const margin = arc ? (opts.simMargin ?? 0.07) : (opts.margin ?? 0.06);
  const scored = [];
  for (const p of people) {
    const tpl = (p.descriptors || []).filter((t) => t.length === D);
    if (!tpl.length) continue;
    if (arc) {
      const sims = tpl.map((t) => cosine(descriptor, t)).sort((a, b) => b - a);
      const v = sims.length > 1 ? (sims[0] * 0.65 + sims[1] * 0.35) : sims[0];
      scored.push({ p, v: Math.max(v, sims[0] - 0.03), best: sims[0] });
    } else {
      let d = Infinity;
      for (const t of tpl) d = Math.min(d, euclidean(descriptor, t));
      scored.push({ p, v: -d, best: -d });
    }
  }
  if (!scored.length) return { matched: false, score: 0, reason: 'Kayıtlı şablon yok' };
  scored.sort((a, b) => b.v - a.v);
  const [best, second] = scored;
  const value = arc ? best.v : -best.v;
  const score = arc ? similarityToScore(value) : distanceToScore(value);
  const out = arc ? { similarity: value } : { distance: value };
  const passes = arc ? value >= thr : value <= thr;
  if (!passes) return { matched: false, score, ...out, reason: 'Kayıtlı kişilerle eşleşmedi' };
  if (second && Math.abs(best.v - second.v) < margin) return { matched: false, score, ...out, reason: 'Belirsiz eşleşme' };
  return { matched: true, person: best.p, score, ...out };
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
