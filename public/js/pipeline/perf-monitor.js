/**
 * Performans, ısı (işlemci baskısı), pil ve bellek izleme + uyarlanabilir analiz hızı.
 *
 * Tarayıcılar cihaz sıcaklığını doğrudan vermez. Bunun yerine:
 *   - Compute Pressure API (PressureObserver, Chrome) → 'nominal' | 'fair' | 'serious' | 'critical'
 *   - Analiz süresinin zamanla uzaması (termal kısıtlama belirtisi)
 *   - Battery Status API
 *   - performance.memory (Chrome) ve TensorFlow.js bellek kullanımı
 * kullanılarak bir "yük çarpanı" hesaplanır; analiz döngüleri bu çarpanla yavaşlatılır.
 */

export class PerfMonitor extends EventTarget {
  constructor() {
    super();
    this.pressure = 'nominal';
    this.battery = null;
    this.stats = new Map(); // ad → {ema, last, count, fps, lastTs}
    this.warnings = new Set();
    this.baseline = new Map();
    this._observer = null;
  }

  async start() {
    try {
      if ('PressureObserver' in window) {
        this._observer = new PressureObserver((records) => {
          const r = records[records.length - 1];
          if (r && r.state !== this.pressure) {
            this.pressure = r.state;
            this._updateWarnings();
          }
        });
        await this._observer.observe('cpu', { sampleInterval: 2000 });
      }
    } catch { /* desteklenmiyor */ }
    try {
      if (navigator.getBattery) {
        this.battery = await navigator.getBattery();
        const upd = () => this._updateWarnings();
        this.battery.addEventListener('levelchange', upd);
        this.battery.addEventListener('chargingchange', upd);
      }
    } catch { /* desteklenmiyor */ }
    this._memTimer = setInterval(() => this._updateWarnings(), 5000);
  }

  stop() {
    try { this._observer?.disconnect(); } catch { /* yok say */ }
    clearInterval(this._memTimer);
  }

  record(name, ms) {
    const now = performance.now();
    const s = this.stats.get(name) || { ema: ms, last: ms, count: 0, fps: 0, lastTs: now, fpsEma: 0 };
    s.ema = s.ema * 0.85 + ms * 0.15;
    s.last = ms;
    s.count++;
    const dt = now - s.lastTs;
    if (dt > 0 && s.count > 1) {
      const inst = 1000 / dt;
      s.fpsEma = s.fpsEma ? s.fpsEma * 0.85 + inst * 0.15 : inst;
    }
    s.lastTs = now;
    this.stats.set(name, s);
    // Termal kısıtlama sezgisi: ilk 50 ölçümün ortalamasına göre belirgin yavaşlama
    if (s.count === 50) this.baseline.set(name, s.ema);
    return s;
  }

  get(name) {
    return this.stats.get(name);
  }

  /** Throttle çarpanı (1 = tam hız) */
  get loadFactor() {
    let f = 1;
    if (this.pressure === 'serious') f *= 1.8;
    if (this.pressure === 'critical') f *= 3;
    if (this.battery && !this.battery.charging && this.battery.level < 0.2) f *= 1.5;
    if (this.isThrottledByHeat()) f *= 1.5;
    if (this.memoryPressure() > 0.85) f *= 1.5;
    return f;
  }

  isThrottledByHeat() {
    for (const [name, base] of this.baseline) {
      const s = this.stats.get(name);
      if (s && s.count > 100 && s.ema > base * 2.2) return true;
    }
    return false;
  }

  memoryPressure() {
    const m = performance.memory;
    if (!m || !m.jsHeapSizeLimit) return 0;
    return m.usedJSHeapSize / m.jsHeapSizeLimit;
  }

  memoryInfo() {
    const m = performance.memory;
    return m ? { usedMB: Math.round(m.usedJSHeapSize / 1048576), limitMB: Math.round(m.jsHeapSizeLimit / 1048576) } : null;
  }

  /**
   * Hedef FPS ve son ölçülen işlem süresine göre bir sonraki analizden önce beklenecek süre.
   * İşlem süresi hedef aralığı aşıyorsa aralık otomatik uzar → işlemci %100'e kilitlenmez.
   */
  nextDelay(name, targetFps) {
    const s = this.stats.get(name);
    const minInterval = 1000 / targetFps;
    const busy = s ? s.ema : 0;
    // İşlemcinin en fazla ~%70'ini bu döngüye ayır
    const interval = Math.max(minInterval, busy / 0.7) * this.loadFactor;
    return Math.max(0, interval - (s ? s.last : 0));
  }

  _updateWarnings() {
    const w = new Set();
    if (this.pressure === 'critical') w.add('Cihaz aşırı yük/ısı altında: analiz hızı düşürüldü.');
    else if (this.pressure === 'serious') w.add('Cihaz ısınıyor: analiz hızı otomatik azaltıldı.');
    if (this.isThrottledByHeat()) w.add('İşlem süreleri uzadı (olası termal kısıtlama). Telefonu serin tutun.');
    if (this.battery && !this.battery.charging && this.battery.level < 0.2) {
      w.add(`Pil düşük (%${Math.round(this.battery.level * 100)}): güç tasarrufu için analiz yavaşlatıldı.`);
    }
    if (this.memoryPressure() > 0.85) w.add('Bellek kullanımı yüksek: önbellekler temizleniyor.');
    const changed = w.size !== this.warnings.size || [...w].some((x) => !this.warnings.has(x));
    this.warnings = w;
    if (changed) this.dispatchEvent(new CustomEvent('warnings', { detail: [...w] }));
    if (this.memoryPressure() > 0.85) this.dispatchEvent(new CustomEvent('memory-pressure'));
  }
}
