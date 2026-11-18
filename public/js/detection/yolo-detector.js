/**
 * ONNX Runtime Web yükleyici ve YOLO nesne algılayıcı.
 *
 * Yürütücü seçimi: cihazda WebGPU varsa modeller GPU'da çalışır (çok daha hızlı); yoksa
 * WASM SIMD (+ çapraz köken izolasyonu varsa çok iş parçacığı) ayrı bir worker'da çalışır.
 *
 * Desteklenen çıktı biçimleri:
 *   'yolov8'  : [1, 4 + sınıf, N]  (cx, cy, w, h, skorlar…)  → NMS burada yapılır
 *   'end2end' : [N, 7]             (batch, x1, y1, x2, y2, sınıf, skor) → NMS modelin içinde
 */
import { nms } from '../vision/imgproc.js';
import { fetchBinary } from '../util/fetch-binary.js';

let ortPromise = null;
export const runtimeInfo = { provider: 'wasm', threads: 1 };

async function webgpuUsable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export async function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('../../vendor/ort/ort.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      const cores = navigator.hardwareConcurrency || 4;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
      ort.env.logLevel = 'error';
      const gpu = await webgpuUsable();
      // WebGPU ana iş parçacığında çalışır (iş GPU'da); WASM ise UI'ı bloklamasın diye proxy worker'da
      ort.env.wasm.proxy = !gpu;
      runtimeInfo.provider = gpu ? 'webgpu' : 'wasm';
      runtimeInfo.threads = ort.env.wasm.numThreads;
      return ort;
    })();
  }
  return ortPromise;
}

/** Bir ONNX modelini en uygun yürütücüyle açar; WebGPU başarısız olursa WASM'a düşer. */
export async function createSession(url, opts = {}) {
  const ort = await loadOrt();
  const bytes = await fetchBinary(url);
  const base = { graphOptimizationLevel: 'all', logSeverityLevel: 3, ...opts };
  if (runtimeInfo.provider === 'webgpu') {
    try {
      return await ort.InferenceSession.create(bytes, { ...base, executionProviders: ['webgpu', 'wasm'] });
    } catch (e) {
      console.warn('WebGPU oturumu açılamadı, WASM kullanılacak', url, e);
    }
  }
  return ort.InferenceSession.create(bytes, { ...base, executionProviders: ['wasm'] });
}

export const COCO_VEHICLE_CLASSES = { 2: 'Otomobil', 3: 'Motosiklet', 5: 'Otobüs', 7: 'Kamyon' };

export class YoloDetector {
  /**
   * @param {object} opts
   * @param {string} opts.url model adresi
   * @param {number} opts.inputSize (ör. 384, 416)
   * @param {Object<number,string>} opts.classes izlenecek sınıf → etiket
   * @param {'yolov8'|'end2end'} [opts.format='yolov8']
   */
  constructor({ url, inputSize = 416, classes, format = 'yolov8' }) {
    this.url = url;
    this.inputSize = inputSize;
    this.classes = classes;
    this.format = format;
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
    this.session = await createSession(this.url);
    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    const s = this.inputSize;
    const dummy = new this.ort.Tensor('float32', new Float32Array(3 * s * s), [1, 3, s, s]);
    await this.session.run({ [this.inputName]: dummy }); // ısınma (GPU gölgelendirici derleme)
    this.ready = true;
  }

  /** Kaynağın (veya bir bölgesinin) letterbox ile model girişine hazırlanması */
  _preprocess(source, region) {
    const S = this.inputSize;
    const SW = source.videoWidth || source.width;
    const SH = source.videoHeight || source.height;
    const r = region || { x: 0, y: 0, w: SW, h: SH };
    const scale = Math.min(S / r.w, S / r.h);
    const nw = Math.round(r.w * scale), nh = Math.round(r.h * scale);
    const px = (S - nw) / 2, py = (S - nh) / 2;
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = S; this._canvas.height = S;
    }
    const ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(source, r.x, r.y, r.w, r.h, Math.round(px - 0.1), Math.round(py - 0.1), nw, nh);
    const { data } = ctx.getImageData(0, 0, S, S);
    const area = S * S;
    const f = new Float32Array(3 * area);
    for (let i = 0, j = 0; i < area; i++, j += 4) {
      f[i] = data[j] / 255;
      f[i + area] = data[j + 1] / 255;
      f[i + 2 * area] = data[j + 2] / 255;
    }
    return { tensor: new this.ort.Tensor('float32', f, [1, 3, S, S]), scale, px, py, r, SW, SH };
  }

  /**
   * @param {object} [o]
   * @param {{x,y,w,h}} [o.region] yalnızca bu bölgede ara (küçük/uzak nesneler için yakınlaştırma etkisi)
   * @returns {Promise<Array<{box:{x,y,w,h}, score:number, cls:number, label:string}>|null>}
   */
  async detect(source, { scoreThreshold = 0.35, iouThreshold = 0.45, region = null } = {}) {
    if (!this.ready || this.busy) return null;
    this.busy = true;
    const t0 = performance.now();
    try {
      const { tensor, scale, px, py, r, SW, SH } = this._preprocess(source, region);
      const out = await this.session.run({ [this.inputName]: tensor });
      const o = out[this.outputName];
      const d = o.data;
      const toFrame = (x1, y1, x2, y2) => {
        const fx1 = Math.max(0, r.x + (x1 - px) / scale), fy1 = Math.max(0, r.y + (y1 - py) / scale);
        const fx2 = Math.min(SW, r.x + (x2 - px) / scale), fy2 = Math.min(SH, r.y + (y2 - py) / scale);
        return { x: fx1, y: fy1, w: Math.max(0, fx2 - fx1), h: Math.max(0, fy2 - fy1) };
      };
      let dets = [];
      if (this.format === 'end2end') {
        const n = o.dims[0];
        for (let i = 0; i < n; i++) {
          const k = i * 7;
          const score = d[k + 6], cls = Math.round(d[k + 5]);
          if (score < scoreThreshold || !(cls in this.classes)) continue;
          dets.push({ ...toFrame(d[k + 1], d[k + 2], d[k + 3], d[k + 4]), score, cls });
        }
      } else {
        const [, dims, n] = o.dims;
        const nc = dims - 4;
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
          dets.push({ ...toFrame(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), score: bestScore, cls: best });
        }
        dets = nms(dets, iouThreshold);
      }
      this.lastMs = performance.now() - t0;
      return dets.filter((k) => k.w > 2 && k.h > 2).map((k) => ({
        box: { x: k.x, y: k.y, w: k.w, h: k.h }, score: k.score, cls: k.cls, label: this.classes[k.cls],
      }));
    } finally {
      this.busy = false;
    }
  }
}
