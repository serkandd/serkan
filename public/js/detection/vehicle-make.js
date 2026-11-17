/**
 * İsteğe bağlı araç marka/model sınıflandırıcısı (ONNX, YOLO-cls biçimi).
 *
 * models/vehicle-make/manifest.json bir model gösteriyorsa yüklenir. Etiketler "Marka|Model"
 * biçimindedir (örn. "Renault|Clio"). Model yoksa marka/model alanları elle doldurulur.
 * Eğitim: scripts/train_vehicle_make_model.py
 */
import { loadOrt } from './yolo-detector.js';
import { fetchBinary } from '../util/fetch-binary.js';

const MANIFEST = new URL('../../models/vehicle-make/manifest.json', import.meta.url).href;

export class VehicleMakeClassifier {
  constructor() {
    this.ready = false;
    this.labels = [];
    this.inputSize = 224;
  }

  async load() {
    const m = await fetch(MANIFEST).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!m?.model) return false;
    this.labels = m.labels || [];
    this.inputSize = m.inputSize || 224;
    this.minConfidence = m.minConfidence ?? 0.6;
    this.ort = await loadOrt();
    this.session = await this.ort.InferenceSession.create(await fetchBinary(new URL(m.model, MANIFEST).href), { executionProviders: ['wasm'] });
    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    this.ready = true;
    return true;
  }

  /** @param {HTMLCanvasElement} canvas araç görüntüsü */
  async classify(canvas) {
    if (!this.ready) return null;
    const S = this.inputSize;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const scale = Math.max(S / canvas.width, S / canvas.height);
    const w = canvas.width * scale, h = canvas.height * scale;
    ctx.drawImage(canvas, (S - w) / 2, (S - h) / 2, w, h);
    const { data } = ctx.getImageData(0, 0, S, S);
    const area = S * S;
    const f = new Float32Array(3 * area);
    for (let i = 0, j = 0; i < area; i++, j += 4) {
      f[i] = data[j] / 255; f[i + area] = data[j + 1] / 255; f[i + 2 * area] = data[j + 2] / 255;
    }
    const out = await this.session.run({ [this.inputName]: new this.ort.Tensor('float32', f, [1, 3, S, S]) });
    const p = out[this.outputName].data;
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    const conf = p[best];
    if (conf < this.minConfidence || !this.labels[best]) return null;
    const [brand, model = ''] = this.labels[best].split('|');
    return { brand, model, confidence: conf };
  }
}
