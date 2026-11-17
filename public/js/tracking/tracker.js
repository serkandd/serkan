/**
 * Çoklu nesne takipçisi (SORT benzeri, saf JavaScript).
 *
 * - Tespitleri mevcut izlerle IoU + merkez mesafesi maliyetiyle eşleştirir (açgözlü atama).
 * - Kutu konum/boyutunu alfa-beta filtresiyle yumuşatır (titreşimi azaltır).
 * - Hız tahmini sayesinde analiz kareleri arasında kutuyu öngörülen konuma taşır;
 *   böylece görüntü katmanı analizden bağımsız akıcı biçimde çizilir.
 * - Bir iz, `minHits` ardışık eşleşmeden sonra "onaylı" olur ve kalıcı takip numarası alır.
 *   Böylece tek karelik yanlış tespitler numara tüketmez, aynı kişi/plaka yeni nesne sayılmaz.
 *
 * Kutu biçimi: {x, y, w, h} (video piksel koordinatı)
 */

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function centerDist(a, b) {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return Math.hypot(dx, dy);
}

let globalSeq = 0;

export class Track {
  constructor(det, now, idPrefix) {
    this.uid = ++globalSeq; // iç numara
    this.id = null; // onaylandığında atanan görünür numara
    this.idPrefix = idPrefix;
    this.box = { ...det.box };
    this.vel = { x: 0, y: 0, w: 0, h: 0 }; // px/ms
    this.score = det.score ?? 1;
    this.scoreAvg = this.score;
    this.hits = 1;
    this.misses = 0;
    this.createdAt = now;
    this.lastSeen = now;
    this.lastUpdate = now;
    this.confirmed = false;
    this.data = {}; // modüllere özel ek bilgi (kimlik, plaka okuması vb.)
    this.payload = det.payload;
  }

  predict(now) {
    const dt = Math.min(now - this.lastUpdate, 500);
    return {
      x: this.box.x + this.vel.x * dt,
      y: this.box.y + this.vel.y * dt,
      w: Math.max(4, this.box.w + this.vel.w * dt),
      h: Math.max(4, this.box.h + this.vel.h * dt),
    };
  }

  update(det, now, alpha, beta) {
    const dt = Math.max(1, now - this.lastUpdate);
    const pred = this.predict(now);
    const m = det.box;
    const keys = ['x', 'y', 'w', 'h'];
    const next = {};
    for (const k of keys) {
      const r = m[k] - pred[k];
      next[k] = pred[k] + alpha * r;
      this.vel[k] = this.vel[k] + (beta * r) / dt;
      // Hızı makul aralıkta tut (kutu "kaçmasın")
      this.vel[k] = Math.max(-2, Math.min(2, this.vel[k]));
    }
    this.box = next;
    this.lastUpdate = now;
    this.lastSeen = now;
    this.hits++;
    this.misses = 0;
    this.score = det.score ?? this.score;
    this.scoreAvg = this.scoreAvg * 0.7 + this.score * 0.3;
    if (det.payload !== undefined) this.payload = det.payload;
  }

  markMissed(now) {
    this.misses++;
    // Kaybolan izi yavaşlat; uzun süre öngörü yapılmasın
    this.vel.x *= 0.5; this.vel.y *= 0.5; this.vel.w *= 0.5; this.vel.h *= 0.5;
    const pred = this.predict(now);
    this.box = pred;
    this.lastUpdate = now;
  }
}

export class MultiObjectTracker {
  /**
   * @param {object} opts
   * @param {string} opts.idPrefix  Görünür numara öneki ("Y" yüz, "P" plaka)
   * @param {number} [opts.iouThreshold=0.2]
   * @param {number} [opts.maxCenterDistFactor=1.0] Kutu boyutuna göre izinli merkez kayması
   * @param {number} [opts.minHits=2]   Onay için gereken eşleşme sayısı
   * @param {number} [opts.maxAgeMs=1500] Görülmeden tutulma süresi
   * @param {number} [opts.alpha=0.55]  Konum yumuşatma
   * @param {number} [opts.beta=0.05]   Hız yumuşatma
   */
  constructor(opts = {}) {
    this.idPrefix = opts.idPrefix ?? 'T';
    this.iouThreshold = opts.iouThreshold ?? 0.2;
    this.maxCenterDistFactor = opts.maxCenterDistFactor ?? 1.0;
    this.minHits = opts.minHits ?? 2;
    this.maxAgeMs = opts.maxAgeMs ?? 1500;
    this.alpha = opts.alpha ?? 0.55;
    this.beta = opts.beta ?? 0.05;
    this.tracks = [];
    this.nextId = 1;
    this.onConfirmed = null;
    this.onRemoved = null;
  }

  /**
   * @param {Array<{box:{x,y,w,h}, score?:number, payload?:any}>} detections
   * @param {number} now ms (performance.now())
   * @returns {Track[]} güncellenen (bu karede eşleşen) izler
   */
  update(detections, now) {
    const tracks = this.tracks;
    const pairs = [];
    const predicted = tracks.map((t) => t.predict(now));
    for (let ti = 0; ti < tracks.length; ti++) {
      for (let di = 0; di < detections.length; di++) {
        const p = predicted[ti];
        const d = detections[di].box;
        const ov = iou(p, d);
        const dist = centerDist(p, d);
        const scale = Math.max(p.w, p.h, d.w, d.h);
        const sizeRatio = Math.max(p.w / d.w, d.w / p.w);
        if (sizeRatio > 2.5) continue;
        if (ov >= this.iouThreshold || dist < scale * this.maxCenterDistFactor * 0.6) {
          // maliyet: düşük daha iyi
          const cost = (1 - ov) + dist / (scale + 1e-6) * 0.5;
          pairs.push({ ti, di, cost });
        }
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const usedT = new Set();
    const usedD = new Set();
    const matched = [];
    for (const { ti, di } of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      const t = tracks[ti];
      t.update(detections[di], now, this.alpha, this.beta);
      matched.push(t);
      if (!t.confirmed && t.hits >= this.minHits) this.#confirm(t);
    }
    for (let ti = 0; ti < tracks.length; ti++) {
      if (!usedT.has(ti)) tracks[ti].markMissed(now);
    }
    for (let di = 0; di < detections.length; di++) {
      if (usedD.has(di)) continue;
      const t = new Track(detections[di], now, this.idPrefix);
      tracks.push(t);
      matched.push(t);
      if (this.minHits <= 1) this.#confirm(t);
    }
    this.prune(now);
    return matched;
  }

  #confirm(t) {
    t.confirmed = true;
    t.id = `${this.idPrefix}${this.nextId++}`;
    this.onConfirmed?.(t);
  }

  prune(now) {
    const keep = [];
    for (const t of this.tracks) {
      const age = now - t.lastSeen;
      const limit = t.confirmed ? this.maxAgeMs : Math.min(400, this.maxAgeMs);
      if (age > limit) this.onRemoved?.(t);
      else keep.push(t);
    }
    this.tracks = keep;
  }

  /** Çizim için: onaylı izler ve öngörülen kutuları */
  snapshot(now) {
    return this.tracks
      .filter((t) => t.confirmed)
      .map((t) => ({ track: t, box: t.misses ? t.box : t.predict(now), stale: now - t.lastSeen > 300 }));
  }

  get confirmedCount() {
    return this.tracks.filter((t) => t.confirmed).length;
  }

  reset() {
    for (const t of this.tracks) this.onRemoved?.(t);
    this.tracks = [];
  }
}
