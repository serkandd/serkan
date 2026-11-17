/**
 * Plaka OCR motoru (Tesseract.js LSTM, kendi Web Worker'larında çalışır).
 *
 * - Tek satır metin modu (PSM 7), yalnızca plaka karakterleri (beyaz liste)
 * - Sözlük kapalı (plaka bir kelime değildir)
 * - Sonuç Türk plaka formatına göre konum farkındalıklı düzeltilir; format dışı ise REDDEDİLİR
 * - Kuyruk dolarsa yeni işler atlanır (gecikme birikmez, pil korunur)
 */
import { OCR_WHITELIST, correctPlate } from './turkish-plate.js';

const BASE = new URL('../../vendor/tesseract/', import.meta.url).href;

export class PlateOcr {
  constructor() {
    this.scheduler = null;
    this.workers = [];
    this.ready = false;
    this.pending = 0;
    this.maxPending = 2;
    this.lastMs = 0;
  }

  async load(onProgress = () => {}, { workers = 1 } = {}) {
    onProgress('OCR motoru yükleniyor');
    const T = await import('../../vendor/tesseract/tesseract.esm.min.js');
    const Tesseract = T.default || T;
    this.scheduler = Tesseract.createScheduler();
    for (let i = 0; i < workers; i++) {
      const w = await Tesseract.createWorker('eng', 1, {
        workerPath: new URL('../workers/tesseract-worker.js', import.meta.url).href,
        corePath: `${BASE}core`,
        langPath: `${BASE}lang`,
        gzip: true,
        cacheMethod: 'write',
        workerBlobURL: false,
      }, {
        load_system_dawg: '0',
        load_freq_dawg: '0',
      });
      await w.setParameters({
        tessedit_char_whitelist: OCR_WHITELIST,
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '0',
        user_defined_dpi: '300',
      });
      this.workers.push(w);
      this.scheduler.addWorker(w);
    }
    this.maxPending = workers * 2;
    this.ready = true;
  }

  get canAccept() {
    return this.ready && this.pending < this.maxPending;
  }

  /**
   * @param {Blob} image ön işlenmiş (ikili) plaka görüntüsü
   * @returns {Promise<{plate:string|null, formatted?:string, raw:string, confidence:number, corrections?:number}|null>}
   *   null → iş kabul edilmedi (kuyruk dolu)
   */
  async read(image, { maxCorrections = 2 } = {}) {
    if (!this.canAccept) return null;
    this.pending++;
    const t0 = performance.now();
    try {
      const { data } = await this.scheduler.addJob('recognize', image, {}, { text: true, blocks: true });
      this.lastMs = performance.now() - t0;
      const raw = (data.text || '').trim();
      const tessConf = Math.max(0, Math.min(100, this._confidence(data))) / 100;
      const corrected = correctPlate(raw, { maxCorrections });
      if (!corrected) return { plate: null, raw, confidence: tessConf };
      const confidence = tessConf * (1 - 0.12 * corrected.corrections);
      return { plate: corrected.plate, formatted: corrected.formatted, raw, confidence, corrections: corrected.corrections };
    } finally {
      this.pending--;
    }
  }

  /**
   * Karakter güvenlerinden plaka güveni: ortalama ile en zayıf karakter harmanlanır;
   * tek bir şüpheli karakter genel güveni belirgin şekilde düşürür.
   */
  _confidence(data) {
    const symbols = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      for (const w of l.words || []) for (const s of w.symbols || []) symbols.push(s.confidence);
    }
    if (!symbols.length) return data.confidence || 0;
    const mean = symbols.reduce((a, b) => a + b, 0) / symbols.length;
    const min = Math.min(...symbols);
    return 0.75 * mean + 0.25 * min;
  }

  async terminate() {
    try { await this.scheduler?.terminate(); } catch { /* yok say */ }
    this.ready = false;
  }
}
