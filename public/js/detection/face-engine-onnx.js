/**
 * Yeni nesil yüz motoru (InsightFace modelleri, ONNX Runtime Web).
 *
 *   Algılama : SCRFD-500M — yüz kutusu + 5 yüz noktası (gözler, burun, ağız köşeleri)
 *   Tanıma   : ArcFace MobileFaceNet (WebFace600K) — 512 boyutlu yüz şablonu
 *
 * Doğruluğu artıran adımlar:
 *   - Hizalama: 5 nokta ile benzerlik dönüşümü → standart 112×112 ArcFace yüz şablonuna oturtma
 *   - Ayna artırımı: yüz ve yatay aynası birlikte işlenip şablonlar toplanır
 *   - Kalite kapısı: boyut, algılama güveni, baş açısı (yaw/roll), netlik
 *
 * Arayüz eski FaceEngine ile aynıdır (detect / describe / describeStill / enrollFromImage).
 */
import { createSession, loadOrt, runtimeInfo } from './yolo-detector.js';
import { laplacianVariance, toGray, nms } from '../vision/imgproc.js';

const BASE = new URL('../../models/face-onnx/', import.meta.url).href;

/** ArcFace 112×112 referans yüz noktaları */
const ARC_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

/** 5 noktadan baş açısı skoru (1 = tam önden) */
export function frontalFromKps(k) {
  const [le, re, no] = k;
  const dx = re[0] - le[0], dy = re[1] - le[1];
  const eye = Math.hypot(dx, dy) || 1;
  const roll = Math.atan2(dy, dx);
  const mx = (le[0] + re[0]) / 2, my = (le[1] + re[1]) / 2;
  // Burnun göz ekseni boyunca kayması → yaw
  const along = ((no[0] - mx) * dx + (no[1] - my) * dy) / eye;
  const yaw = Math.abs(along / eye);
  const yawScore = Math.max(0, 1 - Math.max(0, yaw - 0.12) / 0.45);
  const rollScore = Math.abs(roll) < 0.45 ? 1 : Math.max(0, 1 - (Math.abs(roll) - 0.45) / 0.5);
  return yawScore * rollScore;
}

/** 2B benzerlik dönüşümü (Umeyama, en küçük kareler): src → dst */
export function similarityTransform(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; ux += dst[i][0]; uy += dst[i][1]; }
  mx /= n; my /= n; ux /= n; uy /= n;
  let na = 0, nb = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - mx, ys = src[i][1] - my, xd = dst[i][0] - ux, yd = dst[i][1] - uy;
    na += xs * xd + ys * yd;
    nb += xs * yd - ys * xd;
    den += xs * xs + ys * ys;
  }
  const a = na / den, b = nb / den;
  return { a, b, tx: ux - (a * mx - b * my), ty: uy - (b * mx + a * my) };
}

function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

export class FaceEngineOnnx {
  constructor() {
    this.ready = false;
    this.recognitionReady = false;
    this.inputSize = 512;
    this.kind = 'arcface';
    this.descriptorLength = 512;
  }

  async load(onProgress = () => {}) {
    onProgress('Yüz algılama modeli (SCRFD) yükleniyor');
    this.ort = await loadOrt();
    this.det = await createSession(`${BASE}scrfd-500m.onnx`);
    this.detIn = this.det.inputNames[0];
    this.detOut = this.det.outputNames;
    this.backend = runtimeInfo.provider;
    const warm = document.createElement('canvas');
    warm.width = warm.height = 160;
    await this._scrfd(warm, null, 160, 0.5);
    this.ready = true;
    onProgress('Yüz tanıma modeli (ArcFace) yükleniyor');
    this.rec = await createSession(`${BASE}arcface-mbf.onnx`);
    this.recIn = this.rec.inputNames[0];
    this.recOut = this.rec.outputNames[0];
    await this._embed([this._blank112()]);
    this.recognitionReady = true;
  }

  configure({ inputSize }) {
    if (inputSize) this.inputSize = Math.max(160, Math.round(Number(inputSize) / 32) * 32);
  }

  _blank112() {
    const c = document.createElement('canvas');
    c.width = c.height = 112;
    return c;
  }

  /**
   * SCRFD çalıştırır. `region` verilirse yalnızca o bölge (yakınlaştırarak) analiz edilir.
   * @returns {Array<{box:{x,y,w,h}, score:number, kps:number[][]}>} kaynak koordinatında
   */
  async _scrfd(source, region, S, thresh) {
    const SW = source.videoWidth || source.width, SH = source.videoHeight || source.height;
    const r = region || { x: 0, y: 0, w: SW, h: SH };
    const scale = Math.min(S / r.w, S / r.h);
    const nw = Math.max(1, Math.round(r.w * scale)), nh = Math.max(1, Math.round(r.h * scale));
    if (!this._detCanvas) this._detCanvas = document.createElement('canvas');
    const c = this._detCanvas;
    if (c.width !== S || c.height !== S) { c.width = S; c.height = S; }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, nw, nh);
    const { data } = ctx.getImageData(0, 0, S, S);
    const area = S * S;
    const f = new Float32Array(3 * area);
    for (let i = 0, j = 0; i < area; i++, j += 4) {
      f[i] = (data[j] - 127.5) / 128;
      f[i + area] = (data[j + 1] - 127.5) / 128;
      f[i + 2 * area] = (data[j + 2] - 127.5) / 128;
    }
    const out = await this.det.run({ [this.detIn]: new this.ort.Tensor('float32', f, [1, 3, S, S]) });
    const o = this.detOut.map((n) => out[n].data);
    const faces = [];
    [8, 16, 32].forEach((stride, si) => {
      const scores = o[si], bbox = o[si + 3], kps = o[si + 6];
      const fw = Math.ceil(S / stride);
      const count = scores.length;
      for (let i = 0; i < count; i++) {
        const sc = scores[i];
        if (sc < thresh) continue;
        const pos = i >> 1; // her konumda 2 çapa
        const cx = (pos % fw) * stride, cy = Math.floor(pos / fw) * stride;
        const x1 = cx - bbox[i * 4] * stride, y1 = cy - bbox[i * 4 + 1] * stride;
        const x2 = cx + bbox[i * 4 + 2] * stride, y2 = cy + bbox[i * 4 + 3] * stride;
        const k = [];
        for (let p = 0; p < 5; p++) {
          k.push([r.x + (cx + kps[i * 10 + p * 2] * stride) / scale, r.y + (cy + kps[i * 10 + p * 2 + 1] * stride) / scale]);
        }
        faces.push({
          x: r.x + x1 / scale, y: r.y + y1 / scale, w: (x2 - x1) / scale, h: (y2 - y1) / scale, score: sc, kps: k,
        });
      }
    });
    return nms(faces, 0.4).map((f2) => ({ box: { x: f2.x, y: f2.y, w: f2.w, h: f2.h }, score: f2.score, kps: f2.kps }));
  }

  /** Anonim yüz algılama (tüm kare veya uzak mesafe için iki karo) */
  async detect(source, { tiles = false, scoreThreshold = 0.5 } = {}) {
    if (!this.ready) return [];
    const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
    if (!W || !H) return [];
    if (!tiles) return this._scrfd(source, null, this.inputSize, scoreThreshold);
    // Uzun kenar boyunca örtüşen iki karo: küçük yüzler modele daha büyük girer
    const out = [];
    const horiz = W >= H;
    const L = horiz ? W : H;
    const t = Math.round(L * 0.56);
    for (const o of [0, L - t]) {
      const region = horiz ? { x: o, y: 0, w: t, h: H } : { x: 0, y: o, w: W, h: t };
      out.push(...await this._scrfd(source, region, this.inputSize, scoreThreshold));
    }
    const merged = nms(out.map((d) => ({ ...d.box, score: d.score, kps: d.kps })), 0.4);
    return merged.map((b) => ({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, score: b.score, kps: b.kps }));
  }

  /** 5 noktaya göre 112×112 hizalanmış yüz (ve aynası) */
  _align(source, kps) {
    const t = similarityTransform(kps, ARC_DST);
    const c = document.createElement('canvas');
    c.width = c.height = 112;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 112, 112);
    ctx.setTransform(t.a, t.b, -t.b, t.a, t.tx, t.ty);
    ctx.drawImage(source, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  /** Hizalanmış yüzlerden 512B şablon (ayna artırımlı, L2 normalize) */
  async _embed(aligned) {
    const n = aligned.length * 2;
    const area = 112 * 112;
    const f = new Float32Array(n * 3 * area);
    aligned.forEach((c, i) => {
      const { data } = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 112, 112);
      for (const flip of [0, 1]) {
        const off = (i * 2 + flip) * 3 * area;
        for (let y = 0; y < 112; y++) {
          for (let x = 0; x < 112; x++) {
            const sx = flip ? 111 - x : x;
            const j = (y * 112 + sx) * 4, p = y * 112 + x;
            f[off + p] = (data[j] - 127.5) / 127.5;
            f[off + area + p] = (data[j + 1] - 127.5) / 127.5;
            f[off + 2 * area + p] = (data[j + 2] - 127.5) / 127.5;
          }
        }
      }
    });
    const out = await this.rec.run({ [this.recIn]: new this.ort.Tensor('float32', f, [n, 3, 112, 112]) });
    const e = out[this.recOut].data;
    const D = e.length / n;
    const res = [];
    for (let i = 0; i < aligned.length; i++) {
      const v = new Float32Array(D);
      for (let k = 0; k < D; k++) v[k] = e[(i * 2) * D + k] + e[(i * 2 + 1) * D + k];
      res.push(l2norm(v));
    }
    return res;
  }

  _quality(face, aligned, { minSize, minScore }) {
    const q = { ok: false, reason: '', size: Math.round(face.box.w), score: face.score, frontal: frontalFromKps(face.kps), sharpness: 0 };
    const g = toGray(aligned.getContext('2d', { willReadFrequently: true }).getImageData(24, 24, 64, 64));
    q.sharpness = Math.round(laplacianVariance(g));
    if (q.size < minSize) q.reason = 'Yüz çok küçük / uzak';
    else if (q.score < minScore) q.reason = 'Algılama güveni düşük';
    else if (q.frontal < 0.35) q.reason = 'Yüz kameraya dönük değil';
    else if (q.sharpness < 12) q.reason = 'Görüntü bulanık';
    else q.ok = true;
    return q;
  }

  /**
   * Canlı görüntüdeki bir yüz için kalite ve şablon. Yüzün çevresi tam çözünürlükten yeniden
   * analiz edilir (hassas yüz noktaları için), sonra hizalanıp şablon çıkarılır.
   */
  async describe(source, box, { minSize = 56, minScore = 0.6 } = {}) {
    const quality = { ok: false, reason: '', size: Math.round(box.w) };
    if (!this.recognitionReady) { quality.reason = 'Tanıma modeli yüklenemedi'; return { descriptor: null, quality }; }
    if (box.w < minSize * 0.8) { quality.reason = 'Yüz çok küçük / uzak'; return { descriptor: null, quality }; }
    const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
    const m = 0.6;
    const x = Math.max(0, box.x - box.w * m), y = Math.max(0, box.y - box.h * m);
    const region = { x, y, w: Math.min(W - x, box.w * (1 + 2 * m)), h: Math.min(H - y, box.h * (1 + 2 * m)) };
    const faces = await this._scrfd(source, region, 224, 0.4);
    if (!faces.length) { quality.reason = 'Yüz net seçilemedi'; return { descriptor: null, quality }; }
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const face = faces.sort((a, b) => Math.hypot(a.box.x + a.box.w / 2 - cx, a.box.y + a.box.h / 2 - cy)
      - Math.hypot(b.box.x + b.box.w / 2 - cx, b.box.y + b.box.h / 2 - cy))[0];
    const aligned = this._align(source, face.kps);
    const q = this._quality(face, aligned, { minSize, minScore });
    if (!q.ok) return { descriptor: null, quality: q };
    const [descriptor] = await this._embed([aligned]);
    return { descriptor, quality: q, aligned };
  }

  /** Dondurulmuş kare / fotoğraf üzerinde en büyük yüz */
  async describeStill(canvas, { minSize = 56 } = {}) {
    if (!this.recognitionReady) return { descriptor: null, box: null, reason: 'Yüz tanıma modeli yüklenemedi', faces: 0 };
    const W = canvas.width, H = canvas.height;
    let faces = await this._scrfd(canvas, null, 640, 0.5);
    if (!faces.length && Math.max(W, H) > 900) {
      // Büyük fotoğrafta küçük yüz: iki karoda tekrar dene
      faces = await this.detect(canvas, { tiles: true, scoreThreshold: 0.5 });
    }
    if (!faces.length) return { descriptor: null, box: null, reason: 'Fotoğrafta yüz bulunamadı', faces: 0 };
    const face = faces.sort((a, b) => b.box.w - a.box.w)[0];
    const aligned = this._align(canvas, face.kps);
    const q = this._quality(face, aligned, { minSize, minScore: 0.55 });
    if (!q.ok) return { descriptor: null, box: face.box, reason: q.reason, faces: faces.length };
    const [d] = await this._embed([aligned]);
    return { descriptor: Array.from(d), box: face.box, reason: '', faces: faces.length, score: face.score };
  }

  async enrollFromImage(img) {
    if (!this.recognitionReady) throw new Error('Yüz tanıma modeli yüklenemedi.');
    const c = img instanceof HTMLCanvasElement ? img : (() => {
      const k = document.createElement('canvas');
      k.width = img.naturalWidth || img.width; k.height = img.naturalHeight || img.height;
      k.getContext('2d').drawImage(img, 0, 0);
      return k;
    })();
    const all = await this._scrfd(c, null, 640, 0.5);
    const big = all.filter((f) => f.box.w > 0.35 * Math.max(...all.map((x) => x.box.w)));
    if (big.length > 1) throw new Error(`Fotoğrafta ${big.length} yüz var. Yalnızca kayıt edilecek kişinin yüzü olmalıdır.`);
    const r = await this.describeStill(c, { minSize: 64 });
    if (!r.descriptor) throw new Error(`${r.reason}. Daha net, önden çekilmiş bir fotoğraf kullanın.`);
    return { descriptor: r.descriptor, score: r.score, box: r.box };
  }

  memory() {
    return null;
  }
}
