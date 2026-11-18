/**
 * Derin öğrenme plaka OCR'ı (fast-plate-ocr CCT modeli, ONNX).
 *
 * - Girdi: plaka kırpıntısı → 128×64 RGB (uint8). Birden fazla plaka tek çalıştırmada (batch) okunur.
 * - Çıktı: her karakter yuvası için tüm sınıfların olasılığı.
 * - Olasılıklar Türk plaka formatına göre çözülür (decodeTurkishPlate); kareler arası birleştirme
 *   için ham olasılık matrisi de döndürülür.
 */
import { createSession, loadOrt } from '../detection/yolo-detector.js';
import { decodeTurkishPlate } from './turkish-plate.js';

const MANIFEST = new URL('../../models/plate-ocr/manifest.json', import.meta.url).href;

export class PlateRecognizer {
  constructor() {
    this.ready = false;
    this.lastMs = 0;
    this.busy = false;
  }

  async load() {
    const m = await fetch(MANIFEST).then((r) => r.json());
    this.cfg = {
      slots: m.slots, alphabet: m.alphabet, padChar: m.padChar, w: m.imgWidth, h: m.imgHeight,
    };
    this.ort = await loadOrt();
    this.session = await createSession(new URL(m.model, MANIFEST).href);
    this.inputName = this.session.inputNames[0];
    this.plateOutput = this.session.outputNames.includes('plate') ? 'plate' : this.session.outputNames[0];
    this._canvas = document.createElement('canvas');
    this._canvas.width = this.cfg.w;
    this._canvas.height = this.cfg.h;
    await this.read([{ source: this._canvas, box: { x: 0, y: 0, w: this.cfg.w, h: this.cfg.h } }]); // ısınma
    this.ready = true;
  }

  /**
   * @param {Array<{source:CanvasImageSource, box:{x,y,w,h}}>} items plaka bölgeleri
   * @returns {Promise<Array<{probs:Float32Array, plate:string, confidence:number, raw:string, charConf:number[]}>>}
   */
  async read(items) {
    if (!items.length) return [];
    const { w, h, slots, alphabet } = this.cfg;
    const n = items.length;
    const buf = new Uint8Array(n * h * w * 3);
    const ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    items.forEach((it, i) => {
      const b = it.box;
      // Plakanın kenarlarını kesmemek için hafif genişlet
      const padX = b.w * 0.04, padY = b.h * 0.08;
      const SW = it.source.videoWidth || it.source.width, SH = it.source.videoHeight || it.source.height;
      const x = Math.max(0, b.x - padX), y = Math.max(0, b.y - padY);
      const cw = Math.min(SW - x, b.w + 2 * padX), ch = Math.min(SH - y, b.h + 2 * padY);
      ctx.drawImage(it.source, x, y, cw, ch, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      for (let p = 0, q = i * h * w * 3; p < data.length; p += 4, q += 3) {
        buf[q] = data[p]; buf[q + 1] = data[p + 1]; buf[q + 2] = data[p + 2];
      }
    });
    const t0 = performance.now();
    const out = await this.session.run({ [this.inputName]: new this.ort.Tensor('uint8', buf, [n, h, w, 3]) });
    this.lastMs = performance.now() - t0;
    const all = out[this.plateOutput].data;
    const per = slots * alphabet.length;
    const res = [];
    for (let i = 0; i < n; i++) {
      const probs = Float32Array.from(all.subarray(i * per, (i + 1) * per));
      const d = decodeTurkishPlate(probs, this.cfg);
      res.push({ probs, ...d });
    }
    return res;
  }

  /** Birden çok karenin olasılıklarını (ağırlıklı ortalama) birleştirip yeniden çözer */
  decodeFused(sum, weight) {
    const p = new Float32Array(sum.length);
    for (let i = 0; i < sum.length; i++) p[i] = sum[i] / weight;
    return decodeTurkishPlate(p, this.cfg);
  }
}
