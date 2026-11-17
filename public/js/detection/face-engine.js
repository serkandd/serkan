/**
 * Yüz algılama ve şablon çıkarma motoru (face-api / TensorFlow.js, WebGL hızlandırmalı).
 *
 * İki ayrı sorumluluk vardır ve birbirinden bağımsız çalışır:
 *   1. detect()   → Yalnızca "görüntüde yüz var mı, nerede" (anonim). Her karede çalışabilir.
 *   2. describe() → Yeterli kalitedeki yüz için 128B şablon çıkarır. Kimlik eşleştirmesi
 *                   ayrı modülde (face-match.js) ve yalnızca kayıtlı personel ile yapılır.
 */
import { laplacianVariance, toGray, nms } from '../vision/imgproc.js';
import { frontalScore } from './face-match.js';

const MODEL_URL = new URL('../../models/face/', import.meta.url).href;

export class FaceEngine {
  constructor() {
    this.faceapi = null;
    this.ready = false;
    this.backend = null;
    this.detectorType = 'tiny';
    this.inputSize = 416;
    this.recognitionReady = false;
    this._tileCanvas = null;
    this._cropCanvas = null;
  }

  async load(onProgress = () => {}) {
    onProgress('Yüz algılama kütüphanesi yükleniyor');
    const faceapi = await import('../../vendor/face-api/face-api.esm.js');
    this.faceapi = faceapi;
    const tf = faceapi.tf;
    // GPU (WebGL) öncelikli; olmazsa WASM/CPU
    for (const b of ['webgl', 'wasm', 'cpu']) {
      try {
        if (await tf.setBackend(b)) {
          await tf.ready();
          this.backend = b;
          break;
        }
      } catch { /* sonraki */ }
    }
    if (this.backend === 'webgl') {
      // Mobil GPU'larda bellek baskısını azalt
      try { tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0); } catch { /* yok say */ }
      try { tf.env().set('WEBGL_PACK', true); } catch { /* yok say */ }
    }
    onProgress('Yüz algılama modeli yükleniyor');
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    this.ready = true;
    onProgress('Yüz doğrulama modelleri yükleniyor');
    try {
      await Promise.all([
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      ]);
      this.recognitionReady = true;
    } catch (e) {
      console.error('Yüz doğrulama modelleri yüklenemedi', e);
      this.recognitionReady = false;
    }
    // Isınma çalıştırması (ilk karede gecikmeyi önler)
    const warm = document.createElement('canvas');
    warm.width = warm.height = 128;
    await this.faceapi.detectAllFaces(warm, new faceapi.TinyFaceDetectorOptions({ inputSize: 128 }));
  }

  configure({ detector, inputSize }) {
    if (detector) this.detectorType = detector;
    if (inputSize) this.inputSize = inputSize;
  }

  _options(scoreThreshold = 0.5) {
    const f = this.faceapi;
    if (this.detectorType === 'ssd' && f.nets.ssdMobilenetv1.isLoaded) {
      return new f.SsdMobilenetv1Options({ minConfidence: scoreThreshold, maxResults: 20 });
    }
    return new f.TinyFaceDetectorOptions({ inputSize: this.inputSize, scoreThreshold });
  }

  /**
   * Anonim yüz algılama.
   * @param {HTMLVideoElement|HTMLCanvasElement} source
   * @param {{tiles?:boolean, scoreThreshold?:number}} opts
   * @returns {Promise<Array<{box:{x,y,w,h}, score:number}>>} kaynak piksel koordinatında
   */
  async detect(source, { tiles = false, scoreThreshold = 0.5 } = {}) {
    if (!this.ready) return [];
    const W = source.videoWidth || source.width;
    const H = source.videoHeight || source.height;
    if (!W || !H) return [];
    const toBoxes = (dets, ox = 0, oy = 0, sx = 1, sy = 1) => dets.map((d) => ({
      box: { x: ox + d.box.x * sx, y: oy + d.box.y * sy, w: d.box.width * sx, h: d.box.height * sy },
      score: d.score,
    }));

    if (!tiles) {
      const dets = await this.faceapi.detectAllFaces(source, this._options(scoreThreshold));
      return toBoxes(dets);
    }

    // Uzak mesafe modu: görüntüyü örtüşen iki karoya bölerek her birini tam model çözünürlüğünde analiz et.
    // Küçük (uzaktaki) yüzler model girişinde daha fazla piksel kaplar.
    const overlap = 0.12;
    const tw = Math.round(W * (0.5 + overlap / 2));
    const th = H;
    if (!this._tileCanvas) this._tileCanvas = document.createElement('canvas');
    const c = this._tileCanvas;
    c.width = tw; c.height = th;
    const ctx = c.getContext('2d');
    const out = [];
    for (const ox of [0, W - tw]) {
      ctx.drawImage(source, ox, 0, tw, th, 0, 0, tw, th);
      const dets = await this.faceapi.detectAllFaces(c, this._options(scoreThreshold));
      out.push(...toBoxes(dets, ox, 0));
    }
    const merged = nms(out.map((d) => ({ ...d.box, score: d.score })), 0.35);
    return merged.map((b) => ({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, score: b.score }));
  }

  /**
   * Belirli bir yüz bölgesi için kalite ölçümü ve şablon çıkarımı.
   * Yüz bölgesi tam çözünürlükten kırpılır; böylece uzak yüzlerde de en fazla ayrıntı korunur.
   * @returns {Promise<{descriptor:Float32Array|null, quality:{ok,reason,sharpness,frontal,size,score}}>}
   */
  async describe(source, box, { minSize = 72, minScore = 0.75 } = {}) {
    const quality = { ok: false, reason: '', sharpness: 0, frontal: 0, size: Math.round(box.w), score: 0 };
    if (!this.recognitionReady) { quality.reason = 'Doğrulama modeli yüklenemedi'; return { descriptor: null, quality }; }
    if (box.w < minSize) { quality.reason = 'Yüz çok küçük / uzak'; return { descriptor: null, quality }; }

    const W = source.videoWidth || source.width;
    const H = source.videoHeight || source.height;
    const m = 0.35;
    const x = Math.max(0, box.x - box.w * m);
    const y = Math.max(0, box.y - box.h * m);
    const w = Math.min(W - x, box.w * (1 + 2 * m));
    const h = Math.min(H - y, box.h * (1 + 2 * m));
    const scale = Math.min(1, 320 / Math.max(w, h));
    // Her çağrı kendi tuvalini kullanır: canlı doğrulama ve hızlı kayıt aynı anda çalışabilir
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, x, y, w, h, 0, 0, c.width, c.height);

    // Netlik: yüz merkez bölgesinde Laplace varyansı
    const inner = ctx.getImageData(Math.round(c.width * 0.25), Math.round(c.height * 0.25),
      Math.max(8, Math.round(c.width * 0.5)), Math.max(8, Math.round(c.height * 0.5)));
    quality.sharpness = Math.round(laplacianVariance(toGray(inner)));

    const f = this.faceapi;
    const det = await f.detectSingleFace(c, new f.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!det) { quality.reason = 'Yüz net seçilemedi'; return { descriptor: null, quality }; }
    quality.score = det.detection.score;
    quality.frontal = frontalScore(det.landmarks.positions);

    if (quality.score < minScore) quality.reason = 'Algılama güveni düşük';
    else if (quality.sharpness < 25) quality.reason = 'Görüntü bulanık';
    else if (quality.frontal < 0.3) quality.reason = 'Yüz kameraya dönük değil';
    else quality.ok = true;

    return { descriptor: quality.ok ? det.descriptor : null, quality };
  }

  /**
   * Kayıt fotoğrafından şablon çıkarır. Fotoğrafta tam olarak bir net yüz olmalıdır.
   * Fotoğrafın kendisi saklanmaz; yalnızca şablon (sayı dizisi) döner.
   */
  async enrollFromImage(img) {
    if (!this.recognitionReady) throw new Error('Yüz doğrulama modelleri yüklenemedi.');
    const f = this.faceapi;
    const dets = await f.detectAllFaces(img, new f.SsdMobilenetv1Options({ minConfidence: 0.6 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (!dets.length) throw new Error('Fotoğrafta yüz bulunamadı.');
    if (dets.length > 1) throw new Error(`Fotoğrafta ${dets.length} yüz var. Yalnızca kayıt edilecek kişinin yüzü olmalıdır.`);
    const d = dets[0];
    if (d.detection.box.width < 80) throw new Error('Yüz çok küçük. Daha yakından çekilmiş bir fotoğraf kullanın.');
    if (d.detection.score < 0.8) throw new Error('Yüz net değil. Daha iyi ışıkta çekilmiş bir fotoğraf kullanın.');
    const fr = frontalScore(d.landmarks.positions);
    if (fr < 0.4) throw new Error('Yüz kameraya dönük olmalıdır (önden çekim).');
    return { descriptor: Array.from(d.descriptor), score: d.detection.score, frontal: fr };
  }

  memory() {
    try { return this.faceapi?.tf.memory(); } catch { return null; }
  }
}
