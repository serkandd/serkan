/**
 * YOLOv8 / YOLO11 ONNX nesne algılayıcı (ONNX Runtime Web, WASM SIMD + iş parçacığı, proxy worker).
 *
 * Kullanım alanları:
 *   - Araç algılama: COCO ile eğitilmiş yolov8n (car, motorcycle, bus, truck)
 *   - Plaka algılama: tek sınıflı plaka modeli (models/plate/plate-yolo.onnx) — isteğe bağlı
 *
 * Model çıktısı biçimi: [1, 4 + sınıfSayısı, N]  (cx, cy, w, h, sınıf skorları...)
 */
import { nms } from '../vision/imgproc.js';
import { fetchBinary } from '../util/fetch-binary.js';

let ortPromise = null;

export async function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('../../vendor/ort/ort.wasm.min.mjs').then((ort) => {
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      const cores = navigator.hardwareConcurrency || 4;
      // Çoklu iş parçacığı SharedArrayBuffer gerektirir (cross-origin isolation, bkz. sw.js)
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
      ort.env.wasm.proxy = true; // çıkarımı ayrı bir worker'da çalıştır → UI akıcı kalır
      ort.env.logLevel = 'error';
      return ort;
    });
  }
  return ortPromise;
}

export const COCO_VEHICLE_CLASSES = { 2: 'Otomobil', 3: 'Motosiklet', 5: 'Otobüs', 7: 'Kamyon' };

export class YoloDetector {
  /**
   * @param {object} opts
   * @param {string} opts.url model adresi
   * @param {number} opts.inputSize (ör. 416)
   * @param {Object<number,string>} opts.classes izlenecek sınıf → etiket
   */
  constructor({ url, inputSize = 416, classes }) {
    this.url = url;
    this.inputSize = inputSize;
    this.classes = classes;
    this.session = null;
    this.ort = null;
    this.ready = false;
    this._canvas = null;
    this.lastMs = 0;
    this.busy = false;
  }

  static async exists(url) {
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const type = r.headers.get('content-type') || '';
      return r.ok && !type.includes('text/html');
    } catch {
      return false;
    }
  }

  async load() {
    this.ort = await loadOrt();
    this.session = await this.ort.InferenceSession.create(await fetchBinary(this.url), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    // Isınma
    const s = this.inputSize;
    const dummy = new this.ort.Tensor('float32', new Float32Array(3 * s * s), [1, 3, s, s]);
    await this.session.run({ [this.inputName]: dummy });
    this.ready = true;
  }

  _preprocess(source) {
    const S = this.inputSize;
    const W = source.videoWidth || source.width;
    const H = source.videoHeight || source.height;
    const scale = Math.min(S / W, S / H);
    const nw = Math.round(W * scale), nh = Math.round(H * scale);
    const px = Math.floor((S - nw) / 2), py = Math.floor((S - nh) / 2);
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = S; this._canvas.height = S;
    }
    const ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(source, 0, 0, W, H, px, py, nw, nh);
    const { data } = ctx.getImageData(0, 0, S, S);
    const area = S * S;
    const f = new Float32Array(3 * area);
    for (let i = 0, j = 0; i < area; i++, j += 4) {
      f[i] = data[j] / 255;
      f[i + area] = data[j + 1] / 255;
      f[i + 2 * area] = data[j + 2] / 255;
    }
    return { tensor: new this.ort.Tensor('float32', f, [1, 3, S, S]), scale, px, py, W, H };
  }

  /**
   * @returns {Promise<Array<{box:{x,y,w,h}, score:number, cls:number, label:string}>>}
   */
  async detect(source, { scoreThreshold = 0.35, iouThreshold = 0.45 } = {}) {
    if (!this.ready || this.busy) return null;
    this.busy = true;
    const t0 = performance.now();
    try {
      const { tensor, scale, px, py, W, H } = this._preprocess(source);
      const out = await this.session.run({ [this.inputName]: tensor });
      const o = out[this.outputName];
      const [, dims, n] = o.dims; // [1, 4+nc, N]
      const d = o.data;
      const nc = dims - 4;
      const dets = [];
      const clsIds = Object.keys(this.classes).map(Number);
      for (let i = 0; i < n; i++) {
        let best = -1, bestScore = 0;
        for (const c of clsIds) {
          if (c >= nc) continue;
          const sc = d[(4 + c) * n + i];
          if (sc > bestScore) { bestScore = sc; best = c; }
        }
        if (bestScore < scoreThreshold) continue;
        const cx = d[i], cy = d[n + i], bw = d[2 * n + i], bh = d[3 * n + i];
        const x = (cx - bw / 2 - px) / scale;
        const y = (cy - bh / 2 - py) / scale;
        const w = bw / scale, h = bh / scale;
        dets.push({
          x: Math.max(0, x), y: Math.max(0, y),
          w: Math.min(W, x + w) - Math.max(0, x), h: Math.min(H, y + h) - Math.max(0, y),
          score: bestScore, cls: best,
        });
      }
      const kept = nms(dets, iouThreshold);
      this.lastMs = performance.now() - t0;
      return kept.map((k) => ({
        box: { x: k.x, y: k.y, w: k.w, h: k.h }, score: k.score, cls: k.cls, label: this.classes[k.cls],
      }));
    } finally {
      this.busy = false;
    }
  }
}
