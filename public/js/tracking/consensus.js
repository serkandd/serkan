/**
 * Çok-kareli karar birleştirme (oylama).
 *
 * Tek bir video karesindeki OCR veya yüz eşleşmesi sonucu yanıltıcı olabilir.
 * Aynı iz (track) üzerindeki ardışık sonuçlar güven ağırlıklı olarak biriktirilir;
 * yalnızca yeterli sayıda ve tutarlı sonuç geldiğinde kesin karar verilir.
 */

export class Consensus {
  /**
   * @param {object} opts
   * @param {number} [opts.minVotes=2]       Kesinleşmek için en az oy
   * @param {number} [opts.minAgreement=0.6] Kazanan adayın toplam ağırlıktaki payı
   * @param {number} [opts.minAvgConf=0.6]   Kazanan adayın ortalama güveni (0-1)
   * @param {number} [opts.instantConf=0.93] Bu güvenin üstünde tek oy da yeterli olabilir
   * @param {number} [opts.maxVotes=12]      Kayan pencere boyutu
   */
  constructor(opts = {}) {
    this.minVotes = opts.minVotes ?? 2;
    this.minAgreement = opts.minAgreement ?? 0.6;
    this.minAvgConf = opts.minAvgConf ?? 0.6;
    this.instantConf = opts.instantConf ?? 0.93;
    this.maxVotes = opts.maxVotes ?? 12;
    this.votes = [];
  }

  add(value, conf) {
    if (value == null) return;
    this.votes.push({ value, conf: Math.max(0, Math.min(1, conf)) });
    if (this.votes.length > this.maxVotes) this.votes.shift();
  }

  /** Okunamadı/başarısız denemeleri de say (güvensizlik göstergesi) */
  addFailure() {
    this.votes.push({ value: null, conf: 0.3 });
    if (this.votes.length > this.maxVotes) this.votes.shift();
  }

  get count() {
    return this.votes.filter((v) => v.value != null).length;
  }

  /**
   * @returns {{value:any, confidence:number, votes:number, agreement:number, decided:boolean}|null}
   */
  result() {
    const groups = new Map();
    let total = 0;
    for (const v of this.votes) {
      const w = v.value == null ? v.conf * 0.5 : v.conf;
      total += w;
      if (v.value == null) continue;
      const g = groups.get(v.value) ?? { value: v.value, weight: 0, n: 0, confSum: 0 };
      g.weight += w; g.n++; g.confSum += v.conf;
      groups.set(v.value, g);
    }
    if (!groups.size) return null;
    const best = [...groups.values()].sort((a, b) => b.weight - a.weight)[0];
    const agreement = total > 0 ? best.weight / total : 0;
    const avgConf = best.confSum / best.n;
    const decided =
      (best.n >= this.minVotes && agreement >= this.minAgreement && avgConf >= this.minAvgConf) ||
      (best.n >= 1 && avgConf >= this.instantConf && agreement >= 0.99);
    // Birleşik güven: tek kare güveni, bağımsız karelerde aynı sonucun tekrar okunmasıyla artar
    const repeat = Math.min(1, (best.n - 1) / 4);
    const confidence = Math.min(0.97, avgConf + (1 - avgConf) * agreement * repeat * 0.8) * Math.min(1, agreement + 0.15);
    return {
      value: best.value,
      confidence,
      votes: best.n,
      agreement,
      decided,
    };
  }

  reset() {
    this.votes = [];
  }
}

/**
 * Bildirim tekrarını engelleyen bekleme penceresi.
 * Aynı anahtar (örn. plaka metni veya personel numarası) için `cooldownMs` içinde
 * yalnızca bir kez olay üretilir.
 */
export class Deduplicator {
  constructor(cooldownMs = 60_000) {
    this.cooldownMs = cooldownMs;
    this.seen = new Map();
  }

  shouldEmit(key, now = Date.now()) {
    const last = this.seen.get(key);
    if (last != null && now - last < this.cooldownMs) {
      this.seen.set(key, now); // görünmeye devam ettikçe pencereyi uzat
      return false;
    }
    this.seen.set(key, now);
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) if (now - t > this.cooldownMs) this.seen.delete(k);
    }
    return true;
  }

  clear() {
    this.seen.clear();
  }
}
