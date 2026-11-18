/**
 * Araç görüntüsünden marka/model, kasa tipi ve renk tahmini (CLIP, sıfır-atış).
 *
 * Güvenlik için temkinli karar verir:
 *  - Marka: aynı markanın tüm modellerinin olasılıkları toplanır; yalnızca yeterince yüksekse yazılır
 *  - Model: ayrıca daha yüksek bir eşik gerekir; marka belli ama model belirsizse yalnızca marka yazılır
 *  - Sonuçlar "otomatik tahmin" olarak işaretlenir; kullanıcının girdiği değerin üzerine asla yazılmaz
 */
export const ATTR_THRESHOLDS = { brand: 0.55, model: 0.4, type: 0.5, color: 0.45 };

/**
 * Model büyük (≈90 MB) olduğundan sürekli bellekte tutulmaz: ilk tahminde yüklenir, bir süre
 * kullanılmazsa worker kapatılarak bellek serbest bırakılır (düşük bellekli telefonlarda kapanmayı önler).
 */
export class VehicleAttributeClassifier {
  constructor({ idleMs = 45_000 } = {}) {
    this.ready = true; // gerektiğinde yüklenir
    this.loaded = false;
    this.idleMs = idleMs;
    this._id = 0;
    this._pending = new Map();
    this._queue = Promise.resolve();
    this._worker = null;
    this._loading = null;
    this._idleTimer = null;
  }

  /** Uyumluluk: açılışta yalnızca dosyaların varlığını doğrular, modeli yüklemez */
  async load() {
    const r = await fetch(new URL('../../models/vehicle-clip/labels.json', import.meta.url).href, { method: 'HEAD' });
    if (!r.ok) throw new Error('Araç özellik modeli bulunamadı');
    return true;
  }

  _ensureWorker() {
    if (this._worker) return this._loading;
    this._worker = new Worker(new URL('../workers/clip-worker.js', import.meta.url), { type: 'module' });
    this._loading = new Promise((resolve, reject) => {
      this._worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'ready') { this.loaded = true; resolve(); return; }
        const p = this._pending.get(m.id);
        if (m.type === 'error' && !p) { reject(new Error(m.message)); return; }
        if (!p) return;
        this._pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m.groups);
      };
      this._worker.onerror = (e) => reject(new Error(e.message || 'Araç özellik modeli yüklenemedi'));
      this._worker.postMessage({ type: 'init' });
    });
    this._loading.catch(() => this.unload());
    return this._loading;
  }

  /** Worker'ı kapatır ve modeli bellekten atar */
  unload() {
    clearTimeout(this._idleTimer);
    try { this._worker?.terminate(); } catch { /* yok say */ }
    this._worker = null;
    this._loading = null;
    this.loaded = false;
    for (const p of this._pending.values()) p.reject(new Error('Model kapatıldı'));
    this._pending.clear();
  }

  _armIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.unload(), this.idleMs);
  }

  /** Aracı kırpmadan kare tuvale yerleştirir (kenar boşluğu gri) ve 224×224 RGBA üretir */
  _toInput(source) {
    const W = source.naturalWidth || source.videoWidth || source.width;
    const H = source.naturalHeight || source.videoHeight || source.height;
    const c = document.createElement('canvas');
    c.width = c.height = 224;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(122,116,104)';
    ctx.fillRect(0, 0, 224, 224);
    const s = 224 / Math.max(W, H);
    const w = W * s, h = H * s;
    ctx.drawImage(source, (224 - w) / 2, (224 - h) / 2, w, h);
    return ctx.getImageData(0, 0, 224, 224).data;
  }

  /** @returns {Promise<{brand,model,type,color,brandConf,modelConf,typeConf,colorConf,guess}>} */
  classify(source) {
    const rgba = this._toInput(source);
    const run = async () => {
      clearTimeout(this._idleTimer);
      await this._ensureWorker();
      const groups = await new Promise((resolve, reject) => {
        const id = ++this._id;
        this._pending.set(id, { resolve, reject });
        this._worker.postMessage({ type: 'classify', id, rgba }, [rgba.buffer]);
        setTimeout(() => {
          if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('Araç özellik tahmini zaman aşımı')); }
        }, 60_000);
      });
      this._armIdle();
      return groups;
    };
    const job = this._queue.then(run);
    this._queue = job.catch(() => {});
    return job.then((g) => interpret(g));
  }
}

/** Ham olasılıklardan temkinli karar */
export function interpret(g) {
  const brands = new Map();
  for (const { label, p } of g.make) {
    const b = label.split('|')[0];
    brands.set(b, (brands.get(b) || 0) + p);
  }
  const [brand, brandConf] = [...brands.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const topModel = g.make.find((x) => x.label.startsWith(`${brand}|`));
  const out = {
    brand: brandConf >= ATTR_THRESHOLDS.brand ? brand : '',
    brandConf,
    model: brandConf >= ATTR_THRESHOLDS.brand && topModel && topModel.p >= ATTR_THRESHOLDS.model ? topModel.label.split('|')[1] : '',
    modelConf: topModel?.p || 0,
    type: g.type[0].p >= ATTR_THRESHOLDS.type ? g.type[0].label : '',
    typeConf: g.type[0].p,
    color: g.color[0].p >= ATTR_THRESHOLDS.color ? g.color[0].label : '',
    colorConf: g.color[0].p,
    guess: `${brand} ${topModel ? topModel.label.split('|')[1] : ''}`.trim(),
  };
  return out;
}
