/**
 * Canlı analiz hattı.
 *
 * İki bağımsız, uyarlanabilir hızlı döngü çalışır (biri yavaşlarsa diğerini etkilemez):
 *
 *   YÜZ DÖNGÜSÜ   video → anonim yüz algılama → yüz takipçisi
 *                 → (yalnızca kayıtlı şablon varsa ve kalite yeterliyse) şablon çıkarımı
 *                 → kayıtlı personel ile eşleştirme → çok-kareli oylama → doğrulama sonucu
 *
 *   PLAKA DÖNGÜSÜ video → araç algılama (YOLO) → araç bölgelerinde plaka adayı (Web Worker)
 *                 [+ isteğe bağlı YOLO plaka modeli] → plaka takipçisi
 *                 → (yalnızca kalite yeterliyse) OCR → Türk formatı doğrulama → oylama
 *                 → kayıtlı araç listesiyle karşılaştırma → sonuç
 *
 * Görüntü katmanı (overlay) bu sınıftan bağımsızdır; takipçilerin anlık görüntüsünü
 * kendi requestAnimationFrame döngüsünde okur.
 */
import { MultiObjectTracker } from '../tracking/tracker.js';
import { Consensus, Deduplicator } from '../tracking/consensus.js';
import { matchFace, cosine } from '../detection/face-match.js';
import { nms } from '../vision/imgproc.js';
import { formatPlate } from '../ocr/turkish-plate.js';
import { PerfMonitor } from './perf-monitor.js';
import { estimateVehicleColor } from '../detection/vehicle-color.js';

export const PLATE_RESULT = {
  AUTHORIZED: { key: 'authorized', label: 'Kayıtlı ve yetkili araç', color: 'ok' },
  UNAUTHORIZED: { key: 'registered-unauthorized', label: 'Kayıtlı, yetkisi yok', color: 'danger' },
  NOT_FOUND: { key: 'not-registered', label: 'Yeni araç – listeye eklendi', color: 'info' },
  UNASSIGNED: { key: 'unassigned', label: 'Kayıtlı – bilgi bekliyor', color: 'info' },
  UNREADABLE: { key: 'unreadable', label: 'Plaka okunamadı', color: 'muted' },
};

export const FACE_RESULT = {
  VERIFIED_AUTH: { key: 'verified-authorized', label: 'Doğrulandı · Yetkili', color: 'ok' },
  VERIFIED_UNAUTH: { key: 'verified-unauthorized', label: 'Doğrulandı · Yetkisiz', color: 'danger' },
  UNREGISTERED: { key: 'unregistered', label: 'Kayıtlı personelle eşleşmedi', color: 'info' },
  PENDING: { key: 'pending', label: 'Doğrulanıyor…', color: 'muted' },
  LOW_QUALITY: { key: 'low-quality', label: 'Görüntü kalitesi yetersiz', color: 'muted' },
  ANON: { key: 'anon', label: 'Anonim yüz', color: 'muted' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Analyzer extends EventTarget {
  /**
   * @param {object} deps
   * @param {HTMLVideoElement} deps.video
   * @param {import('../detection/face-engine.js').FaceEngine} deps.face
   * @param {import('../detection/yolo-detector.js').YoloDetector|null} deps.vehicle
   * @param {import('../detection/yolo-detector.js').YoloDetector|null} deps.plateModel
   * @param {Worker} deps.plateWorker
   * @param {import('../ocr/plate-ocr.js').PlateOcr} deps.ocr
   * @param {object} deps.registry {personnel():[], findVehicleByPlate(plate)}
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
    this.perf = new PerfMonitor();
    this.running = false;
    this.faceEnabled = true;
    this.plateEnabled = true;
    this.settings = {};

    this.faceTracker = new MultiObjectTracker({ idPrefix: 'Y', minHits: 2, maxAgeMs: 1500, iouThreshold: 0.15 });
    this.plateTracker = new MultiObjectTracker({ idPrefix: 'P', minHits: 2, maxAgeMs: 2500, iouThreshold: 0.1, alpha: 0.6 });
    this.vehicleTracker = new MultiObjectTracker({ idPrefix: 'A', minHits: 2, maxAgeMs: 1500, iouThreshold: 0.2 });

    this.plateDedup = new Deduplicator(60_000);
    this.faceDedup = new Deduplicator(60_000);
    this.status = {
      face: { state: 'idle', message: 'Beklemede' },
      plate: { state: 'idle', message: 'Beklemede' },
    };
    this._reqId = 0;
    this._pendingWorker = new Map();
    this._faceErrors = 0;
    this._plateErrors = 0;

    this.plateWorker.onmessage = (e) => {
      const p = this._pendingWorker.get(e.data.id);
      if (!p) return;
      this._pendingWorker.delete(e.data.id);
      if (e.data.type === 'error') p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    this.plateWorker.onerror = (e) => {
      for (const p of this._pendingWorker.values()) p.reject(new Error(e.message || 'Plaka worker hatası'));
      this._pendingWorker.clear();
    };

    this.perf.addEventListener('memory-pressure', () => this._relieveMemory());
    this.perf.addEventListener('warnings', (e) => this.dispatchEvent(new CustomEvent('warnings', { detail: e.detail })));
  }

  applySettings(s) {
    this.settings = s;
    this.plateDedup.cooldownMs = s.dedupSeconds * 1000;
    this.faceDedup.cooldownMs = s.dedupSeconds * 1000;
    this.face?.configure({ detector: s.detector, inputSize: s.faceInputSize });
  }

  _setStatus(kind, state, message) {
    const prev = this.status[kind];
    if (prev.state === state && prev.message === message) return;
    this.status[kind] = { state, message };
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.perf.start();
    this._faceLoop();
    this._plateLoop();
  }

  stop() {
    this.running = false;
    this.perf.stop();
    this.faceTracker.reset();
    this.plateTracker.reset();
    this.vehicleTracker.reset();
    this._setStatus('face', 'idle', 'Durduruldu');
    this._setStatus('plate', 'idle', 'Durduruldu');
  }

  /** Yüz kaydı gibi işlemler sırasında canlı analizi geçici olarak durdurur (işlemci/GPU serbest kalır) */
  pause() { this.paused = true; }
  resume() { this.paused = false; }

  _videoReady() {
    const v = this.video;
    if (this.paused) return false;
    return v.readyState >= 2 && v.videoWidth > 0 && !v.paused && document.visibilityState === 'visible';
  }

  /* ================================================================ YÜZ */

  async _faceLoop() {
    while (this.running) {
      if (!this.faceEnabled || !this.face?.ready) {
        this._setStatus('face', this.face?.ready ? 'off' : 'error', this.face?.ready ? 'Kapalı' : 'Model yüklenemedi');
        this.faceTracker.update([], performance.now());
        await sleep(400);
        continue;
      }
      if (!this._videoReady()) { await sleep(200); continue; }
      const t0 = performance.now();
      try {
        const dets = await this.face.detect(this.video, {
          tiles: this.settings.longRangeTiles,
          scoreThreshold: 0.45,
        });
        const now = performance.now();
        const tracks = this.faceTracker.update(dets.map((d) => ({ box: d.box, score: d.score })), now);
        this.perf.record('face', performance.now() - t0);
        const n = this.faceTracker.confirmedCount;
        this._setStatus('face', n ? 'active' : 'ready', n ? `${n} yüz takip ediliyor` : 'Yüz aranıyor');
        await this._verifyFaces(tracks, now);
        this._faceErrors = 0;
      } catch (err) {
        this._faceErrors++;
        console.error('Yüz döngüsü hatası', err);
        if (this._faceErrors > 5) {
          this._setStatus('face', 'error', 'Yüz analizi hata veriyor, yeniden deneniyor');
          await sleep(2000);
        }
      }
      await sleep(this.perf.nextDelay('face', this.settings.targetFps || 12));
    }
  }

  async _verifyFaces(tracks, now) {
    const people = this.registry.personnel().filter((p) => p.descriptors?.length);
    for (const t of this.faceTracker.tracks) {
      if (!t.data.result) t.data.result = people.length ? FACE_RESULT.PENDING : FACE_RESULT.ANON;
      if (!people.length && t.data.result !== FACE_RESULT.ANON && !t.data.decided) t.data.result = FACE_RESULT.ANON;
    }
    if (!people.length || !this.face.recognitionReady) return;

    // Her döngüde en fazla bir yüz için şablon çıkar (pahalı işlem); en büyük ve en çok bekleyeni seç
    const s = this.settings;
    const candidates = this.faceTracker.tracks
      .filter((t) => t.confirmed && t.misses === 0)
      .filter((t) => {
        const interval = t.data.decided ? 3000 : 500;
        return now - (t.data.lastDescribeAt || 0) > interval;
      })
      .sort((a, b) => (a.data.lastDescribeAt || 0) - (b.data.lastDescribeAt || 0) || b.box.w - a.box.w);
    const t = candidates[0];
    if (!t) return;
    t.data.lastDescribeAt = now;
    if (!t.data.consensus) t.data.consensus = new Consensus({ minVotes: s.faceVerifyVotes, minAgreement: 0.7, minAvgConf: 0.5, instantConf: 2 });

    const box = t.predict(performance.now());
    const t0 = performance.now();
    const { descriptor, quality } = await this.face.describe(this.video, box, { minSize: s.faceMinSizePx, minScore: s.faceMinScore });
    this.perf.record('faceDescribe', performance.now() - t0);
    // Beklerken iz sıfırlanmış olabilir (ör. yeni kişi kaydı sonrası): bu sonucu atla
    if (!t.data.consensus) return;
    t.data.quality = quality;
    if (!descriptor) {
      if (!t.data.decided) t.data.result = { ...FACE_RESULT.LOW_QUALITY, label: `Kalite yetersiz: ${quality.reason}` };
      return;
    }
    const m = matchFace(descriptor, people, {
      threshold: s.faceMatchThreshold, margin: s.faceMatchMargin,
      simThreshold: s.faceSimThreshold, simMargin: s.faceSimMargin,
    });
    t.data.lastScore = m.score;
    if (m.matched) {
      // Çok güçlü ve kaliteli eşleşmede tek kare yeterli; aksi halde oylama
      const strong = m.similarity != null && m.similarity >= (s.faceSimThreshold ?? 0.42) + 0.18;
      t.data.consensus.add(m.person.id, m.score / 100);
      if (strong) t.data.consensus.add(m.person.id, m.score / 100);
      this._maybeLearn(m, descriptor, quality);
    } else {
      t.data.consensus.add('__none__', m.reason === 'Belirsiz eşleşme' ? 0.5 : 0.8);
    }

    const r = t.data.consensus.result();
    if (!r?.decided) {
      if (!t.data.decided) t.data.result = { ...FACE_RESULT.PENDING, label: `Doğrulanıyor… (${t.data.consensus.count}/${s.faceVerifyVotes})` };
      return;
    }
    const prevKey = t.data.identityKey;
    t.data.decided = true;
    t.data.identityKey = r.value;
    if (r.value === '__none__') {
      t.data.person = null;
      t.data.result = FACE_RESULT.UNREGISTERED;
      t.data.confidence = r.confidence;
      if (prevKey !== r.value) this._emitFace(t, null, r.confidence);
    } else {
      const person = people.find((p) => p.id === r.value);
      t.data.person = person;
      t.data.confidence = r.confidence;
      t.data.result = person?.status === 'authorized' ? FACE_RESULT.VERIFIED_AUTH : FACE_RESULT.VERIFIED_UNAUTH;
      if (prevKey !== r.value) this._emitFace(t, person, r.confidence);
    }
  }

  /**
   * Uyarlanabilir öğrenme: kişi yüksek güvenle ve iyi kalitede tanındığında, kayıtlı şablonlarından
   * belirgin şekilde farklı (yeni ışık / açı / gözlük vb.) bir görünüm ise şablon olarak eklenir.
   * Yanlış kişiye kaymayı önlemek için yalnızca çok yüksek benzerlikte ve seyrek yapılır.
   */
  _maybeLearn(m, descriptor, quality) {
    if (!this.settings.faceAdaptiveLearning || m.similarity == null) return;
    if (m.similarity < (this.settings.faceSimThreshold ?? 0.42) + 0.12 || quality.frontal < 0.6) return;
    const p = m.person;
    const tpl = (p.descriptors || []).filter((d) => d.length === descriptor.length);
    if (tpl.length >= 12) return;
    this._learnedAt = this._learnedAt || new Map();
    if (Date.now() - (this._learnedAt.get(p.id) || 0) < 60_000) return;
    const maxSim = Math.max(...tpl.map((d) => cosine(descriptor, d)));
    if (maxSim > 0.8) return; // zaten benzer bir şablon var
    this._learnedAt.set(p.id, Date.now());
    this.dispatchEvent(new CustomEvent('learn', { detail: { personId: p.id, descriptor: Array.from(descriptor) } }));
  }

  /** Yüzün küçük resmi (olay listesinde gösterilir) */
  _faceThumb(box) {
    const v = this.video;
    const W = v.videoWidth, H = v.videoHeight;
    const m = 0.3;
    const x = Math.max(0, box.x - box.w * m), y = Math.max(0, box.y - box.h * m);
    const w = Math.min(W - x, box.w * (1 + 2 * m)), h = Math.min(H - y, box.h * (1 + 2 * m));
    if (w < 8 || h < 8) return Promise.resolve(null);
    const scale = Math.min(1, 128 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
  }

  async _emitFace(track, person, confidence) {
    const key = person ? `p:${person.id}` : `anon:${track.uid}`;
    if (!this.faceDedup.shouldEmit(key)) return;
    const thumb = this.settings.storeFaceThumbnails ? await this._faceThumb(track.box).catch(() => null) : null;
    this.dispatchEvent(new CustomEvent('detection', {
      detail: {
        kind: 'face',
        result: track.data.result.key,
        label: track.data.result.label,
        trackId: track.id,
        confidence: Math.round(confidence * 100),
        personId: person?.id ?? null,
        employeeNo: person?.employeeNo ?? null,
        fullName: person?.fullName ?? null,
        thumb,
      },
    }));
  }

  /* ============================================================== PLAKA */

  _workerAnalyze(bitmap, rois, fullFrame) {
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._pendingWorker.set(id, { resolve, reject });
      this.plateWorker.postMessage({ type: 'analyze', id, bitmap, rois, fullFrame, maxFullWidth: 1024 }, [bitmap]);
      setTimeout(() => {
        if (this._pendingWorker.has(id)) {
          this._pendingWorker.delete(id);
          reject(new Error('Plaka analizi zaman aşımı'));
        }
      }, 5000);
    });
  }

  async _plateLoop() {
    let cycle = 0;
    while (this.running) {
      if (!this.plateEnabled) {
        this._setStatus('plate', 'off', 'Kapalı');
        this.plateTracker.update([], performance.now());
        this.vehicleTracker.update([], performance.now());
        await sleep(400);
        continue;
      }
      if (!this._videoReady()) { await sleep(200); continue; }
      const t0 = performance.now();
      cycle++;
      if (this.plateDetector?.ready && this.plateOcr?.ready) {
        try {
          await this._plateCycleModel(cycle, t0);
          this._plateErrors = 0;
        } catch (err) {
          this._plateErrors++;
          console.error('Plaka döngüsü hatası', err);
          if (this._plateErrors > 3) {
            this._setStatus('plate', 'error', 'Plaka analizi hata veriyor, yeniden deneniyor');
            await sleep(1500);
          }
        }
        await sleep(this.perf.nextDelay('plate', 6));
        continue;
      }
      try {
        // 1) Araç algılama
        let vehicles = [];
        if (this.vehicle?.ready) {
          const v = await this.vehicle.detect(this.video, { scoreThreshold: 0.35 });
          if (v) vehicles = v;
          this.vehicleTracker.update(vehicles.map((d) => ({ box: d.box, score: d.score, payload: { label: d.label } })), performance.now());
        }
        // 2) Plaka adayları: araç bölgelerinde + periyodik tam kare (yakın plakalar aracın tamamı görünmeden de okunabilsin)
        const rois = vehicles.filter((v) => v.box.w > 60).slice(0, 4).map((v) => v.box);
        const fullFrame = !this.vehicle?.ready || !rois.length || cycle % 3 === 0;
        const bitmap = await createImageBitmap(this.video);
        const res = await this._workerAnalyze(bitmap, rois, fullFrame);

        let dets = res.plates.map((p) => ({ box: p.box, score: p.score, payload: p }));
        // 3) İsteğe bağlı YOLO plaka modeli
        if (this.plateModel?.ready) {
          const pm = await this.plateModel.detect(this.video, { scoreThreshold: 0.4 });
          if (pm) dets = this._mergePlateModel(dets, pm);
        }
        const now = performance.now();
        this.plateTracker.update(dets, now);
        this.perf.record('plate', performance.now() - t0);
        this.perf.record('plateWorker', res.ms);

        await this._readPlates(now);
        const n = this.plateTracker.tracks.filter((t) => t.confirmed && t.data.plate).length;
        const nc = this.plateTracker.tracks.filter((t) => t.confirmed && !t.data.rejected).length;
        const vc = this.vehicleTracker.confirmedCount;
        this._setStatus('plate', nc || vc ? 'active' : 'ready',
          nc ? `${nc} plaka takipte${n ? `, ${n} okundu` : ''}` : vc ? `${vc} araç, plaka aranıyor` : 'Plaka aranıyor');
        this._plateErrors = 0;
      } catch (err) {
        this._plateErrors++;
        console.error('Plaka döngüsü hatası', err);
        if (this._plateErrors > 3) {
          this._setStatus('plate', 'error', 'Plaka analizi hata veriyor, yeniden deneniyor');
          await sleep(1500);
        }
      }
      await sleep(this.perf.nextDelay('plate', 5));
    }
  }

  /**
   * Model tabanlı plaka döngüsü:
   *  1. Araç algılama (her 2 döngüde bir) → araç bölgeleri
   *  2. Plaka algılama: en büyük 2 aracın plaka bölgesinde (yakınlaştırılmış) + dönüşümlü tarama
   *     (tam kare / sol-üst yarı / sağ-alt yarı) → uzak plakalar da modele büyük girer
   *  3. Takip → okunmamış plakalar tek seferde (batch) OCR → kareler arası olasılık birleştirme
   */
  async _plateCycleModel(cycle, t0) {
    const v = this.video;
    const W = v.videoWidth, H = v.videoHeight;
    let vehicles = this._lastVehicles || [];
    if (this.vehicle?.ready && (cycle % 2 === 1 || !this._lastVehicles)) {
      const r = await this.vehicle.detect(v, { scoreThreshold: 0.35 });
      if (r) {
        vehicles = r;
        this._lastVehicles = r;
        this.vehicleTracker.update(r.map((d) => ({ box: d.box, score: d.score, payload: { label: d.label } })), performance.now());
      }
    }
    const regions = [];
    for (const veh of [...vehicles].filter((x) => x.box.w > 48).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h).slice(0, 2)) {
      const b = veh.box;
      const x = Math.max(0, b.x - b.w * 0.08), y = Math.max(0, b.y + b.h * 0.2);
      regions.push({ x, y, w: Math.min(W - x, b.w * 1.16), h: Math.min(H - y, b.h * 0.9) });
    }
    const horiz = W >= H;
    const L = horiz ? W : H, T = Math.round(L * 0.56);
    const scans = [null,
      horiz ? { x: 0, y: 0, w: T, h: H } : { x: 0, y: 0, w: W, h: T },
      horiz ? { x: W - T, y: 0, w: T, h: H } : { x: 0, y: H - T, w: W, h: T }];
    // Araç varken plaka zaten araç bölgesinde aranır; genel tarama seyrekleşir (telefon yükü azalır)
    if (!regions.length || cycle % 3 === 0) regions.push(scans[Math.floor(cycle / (regions.length ? 3 : 1)) % 3]);

    let found = [];
    for (const region of regions) {
      const r = await this.plateDetector.detect(v, { region, scoreThreshold: 0.35 });
      if (r) found.push(...r.map((d) => ({ ...d.box, score: d.score })));
    }
    found = nms(found, 0.4);
    const now = performance.now();
    this.plateTracker.update(found.map((b) => ({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, score: b.score, payload: { fromModel: true } })), now);
    this.perf.record('plateDetect', performance.now() - t0);

    await this._readPlatesModel(now);
    this.perf.record('plate', performance.now() - t0);
    const n = this.plateTracker.tracks.filter((t) => t.confirmed && t.data.plate).length;
    const nc = this.plateTracker.confirmedCount;
    const vc = this.vehicleTracker.confirmedCount;
    this._setStatus('plate', nc || vc ? 'active' : 'ready',
      nc ? `${nc} plaka takipte${n ? `, ${n} okundu` : ''}` : vc ? `${vc} araç, plaka aranıyor` : 'Plaka aranıyor');
  }

  async _readPlatesModel(now) {
    const s = this.settings;
    const tracks = this.plateTracker.tracks
      .filter((t) => t.confirmed && t.misses === 0)
      .filter((t) => now - (t.data.lastOcrAt || 0) > (t.data.decided ? 1500 : 0))
      .sort((a, b) => b.box.w - a.box.w)
      .slice(0, 4);
    if (!tracks.length) return;
    const t0 = performance.now();
    const res = await this.plateOcr.read(tracks.map((t) => ({ source: this.video, box: t.box })));
    this.perf.record('ocr', performance.now() - t0);
    const minConf = s.plateMinOcrConf ?? 0.5;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i], d = t.data, r = res[i];
      d.lastOcrAt = now;
      d.attempts = (d.attempts || 0) + 1;
      d.lastRaw = r.raw;
      // Büyük (yakın) plakaların okuması daha güvenilirdir → daha yüksek ağırlık
      const w = 0.4 + Math.min(1, t.box.w / 160);
      if (!d.probSum) { d.probSum = new Float32Array(r.probs.length); d.weight = 0; }
      for (let k = 0; k < r.probs.length; k++) d.probSum[k] += r.probs[k] * w;
      d.weight += w;
      d.n = (d.n || 0) + 1;
      const fused = this.plateOcr.decodeFused(d.probSum, d.weight);
      d.candidate = fused.plate;
      d.candidateConf = fused.confidence;
      d.hint = t.box.w < 60 ? 'plaka uzak' : '';
      const decided = fused.valid && (
        (d.n >= (s.plateVotes ?? 2) && fused.confidence >= minConf)
        || (fused.confidence >= 0.92 && r.confidence >= 0.92));
      if (decided) {
        if (!d.thumb || d.plate !== fused.plate) d.thumb = await this._plateThumb(t.box).catch(() => null);
        this._applyPlateDecision(t, fused.plate, fused.confidence);
      } else if (!d.decided && !d.unreadable && d.n >= 10) {
        d.unreadable = true;
        d.result = PLATE_RESULT.UNREADABLE;
        this._emitPlate(t, null, 0);
      }
    }
  }

  _plateThumb(box) {
    const v = this.video;
    const c = document.createElement('canvas');
    const scale = Math.min(1, 320 / box.w);
    c.width = Math.max(8, Math.round(box.w * scale)); c.height = Math.max(4, Math.round(box.h * scale));
    c.getContext('2d').drawImage(v, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
  }

  _applyPlateDecision(t, plate, confidence) {
    const d = t.data;
    const changed = d.plate !== plate;
    d.plate = plate;
    d.plateFormatted = formatPlate(plate);
    d.confidence = confidence;
    d.decided = true;
    d.unreadable = false;
    const vehicle = this.registry.findVehicleByPlate(plate);
    d.vehicle = vehicle;
    if (!vehicle) d.result = PLATE_RESULT.NOT_FOUND;
    else if (vehicle.status === 'unassigned') d.result = PLATE_RESULT.UNASSIGNED;
    else if (vehicle.status === 'authorized' && !(vehicle.validUntil && new Date(vehicle.validUntil) < new Date())) d.result = PLATE_RESULT.AUTHORIZED;
    else d.result = PLATE_RESULT.UNAUTHORIZED;
    if (changed) this._emitPlate(t, vehicle, confidence);
  }

  /** YOLO plaka kutularını klasik adaylarla birleştir: model kutusu öncelikli, OCR verisi adaydan alınır */
  _mergePlateModel(cands, modelDets) {
    const out = [...cands];
    for (const m of modelDets) {
      const overlap = out.find((c) => {
        const ix = Math.max(0, Math.min(c.box.x + c.box.w, m.box.x + m.box.w) - Math.max(c.box.x, m.box.x));
        const iy = Math.max(0, Math.min(c.box.y + c.box.h, m.box.y + m.box.h) - Math.max(c.box.y, m.box.y));
        return ix * iy > 0.3 * Math.min(c.box.w * c.box.h, m.box.w * m.box.h);
      });
      if (overlap) {
        overlap.score = Math.max(overlap.score, m.score);
        overlap.payload = { ...overlap.payload, fromModel: true };
      }
    }
    return out;
  }

  async _readPlates(now) {
    const s = this.settings;
    const jobs = [];
    const tracks = this.plateTracker.tracks
      .filter((t) => t.confirmed && t.misses === 0 && t.payload)
      .sort((a, b) => b.box.w - a.box.w);
    for (const t of tracks) {
      const d = t.data;
      if (!d.consensus) d.consensus = new Consensus({ minVotes: s.plateVotes, minAgreement: 0.7, minAvgConf: s.plateMinOcrConf, instantConf: 0.97 });
      d.attempts = d.attempts || 0;
      const p = t.payload;
      // En iyi küçük resmi sakla (olay kaydı için)
      if (p.thumbBlob && (!d.bestQuality || p.quality.sharpness > d.bestQuality.sharpness)) {
        d.bestQuality = p.quality;
        d.thumb = p.thumbBlob;
      }
      d.quality = p.quality;
      const interval = d.decided ? 2000 : d.rejected ? 3000 : 250;
      if (now - (d.lastOcrAt || 0) < interval) continue;
      if (!p.ocrBlob) {
        // Kalite yetersiz: OCR çalıştırılmaz (pil/işlemci tasarrufu ve yanlış okuma önlemi)
        if (!d.decided) d.hint = p.quality.reason;
        continue;
      }
      if (!this.ocr?.canAccept) break;
      d.lastOcrAt = now;
      d.attempts++;
      jobs.push(this._ocrTrack(t, p.ocrBlob));
    }
    // OCR beklenmeden döngü devam eder; sonuçlar geldikçe ize işlenir
    Promise.allSettled(jobs);

    // Uzun süre okunamayan adaylar:
    //  - Plakaya benzer kısmi metin okunmuşsa, YOLO plaka modelinden geliyorsa veya bir aracın
    //    üzerindeyse → "Plaka okunamadı" (bulanık / kapalı / uzak plaka)
    //  - Hiç plaka benzeri metin çıkmadıysa (tabela, jaluzi, desen) → aday reddedilir, gösterilmez
    for (const t of tracks) {
      const d = t.data;
      if (d.decided || d.unreadable || d.rejected) continue;
      const stuck = d.attempts >= 8 || (now - t.createdAt > 4000 && d.attempts === 0);
      if (!stuck) continue;
      const plateLike = (d.partialReads || 0) >= 2 || t.payload?.fromModel || this._onVehicle(t.box);
      if (plateLike && t.scoreAvg >= 0.5) {
        d.unreadable = true;
        d.result = PLATE_RESULT.UNREADABLE;
        this._emitPlate(t, null, 0);
      } else {
        d.rejected = true;
      }
    }
  }

  _onVehicle(box) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    return this.vehicleTracker.tracks.some((v) => v.confirmed
      && cx > v.box.x && cx < v.box.x + v.box.w && cy > v.box.y && cy < v.box.y + v.box.h);
  }

  async _ocrTrack(t, blob) {
    const d = t.data;
    try {
      const t0 = performance.now();
      const r = await this.ocr.read(blob, { maxCorrections: 2 });
      this.perf.record('ocr', performance.now() - t0);
      if (!r) return;
      if (r.plate) d.consensus.add(r.plate, r.confidence);
      else d.consensus.addFailure();
      d.lastRaw = r.raw;
      if (r.plate || /[A-Z0-9]{4,}/.test(r.raw.replace(/\s/g, ''))) d.partialReads = (d.partialReads || 0) + 1;
      if (r.plate && d.rejected) d.rejected = false;
      const res = d.consensus.result();
      if (res) {
        d.candidate = res.value;
        d.candidateConf = res.confidence;
      }
      if (res?.decided) {
        const changed = d.plate !== res.value;
        d.plate = res.value;
        d.plateFormatted = formatPlate(res.value);
        d.confidence = res.confidence;
        d.decided = true;
        d.unreadable = false;
        const vehicle = this.registry.findVehicleByPlate(res.value);
        d.vehicle = vehicle;
        if (!vehicle) d.result = PLATE_RESULT.NOT_FOUND;
        else if (vehicle.status === 'unassigned') d.result = PLATE_RESULT.UNASSIGNED;
        else if (vehicle.status === 'authorized' && !(vehicle.validUntil && new Date(vehicle.validUntil) < new Date())) d.result = PLATE_RESULT.AUTHORIZED;
        else d.result = PLATE_RESULT.UNAUTHORIZED;
        if (changed) this._emitPlate(t, vehicle, res.confidence);
      }
    } catch (err) {
      console.error('OCR hatası', err);
      d.consensus?.addFailure();
    }
  }

  /** Plakanın üzerinde bulunduğu araç izi */
  _vehicleFor(box) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    return this.vehicleTracker.tracks
      .filter((v) => cx > v.box.x && cx < v.box.x + v.box.w && cy > v.box.y && cy < v.box.y + v.box.h)
      .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0] || null;
  }

  /**
   * Aracın genel görüntüsünü kırpar, rengini ve türünü çıkarır. Araç algılayıcı aracı bulamadıysa
   * plakanın çevresindeki bölge (aracın ön/arka yüzü) kullanılır.
   */
  _vehicleSnapshot(plateBox) {
    const v = this.video;
    const W = v.videoWidth, H = v.videoHeight;
    if (!W || !H) return null;
    const vt = this._vehicleFor(plateBox);
    let r = vt ? { ...vt.box } : {
      x: plateBox.x - plateBox.w * 1.6, y: plateBox.y - plateBox.h * 4.5, w: plateBox.w * 4.2, h: plateBox.h * 6,
    };
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    r = { x, y, w: Math.min(W, r.x + r.w) - x, h: Math.min(H, r.y + r.h) - y };
    if (r.w < 16 || r.h < 16) return null;
    const scale = Math.min(1, 480 / Math.max(r.w, r.h));
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const plateRel = {
      x: (plateBox.x - r.x) * scale, y: (plateBox.y - r.y) * scale, w: plateBox.w * scale, h: plateBox.h * scale,
    };
    const color = estimateVehicleColor(img, plateRel);
    return {
      canvas: c,
      photo: c.toDataURL('image/jpeg', 0.75),
      color: color.confidence >= 0.3 ? color.name : '',
      vehicleType: vt?.payload?.label || '',
    };
  }

  async _emitPlate(track, vehicle, confidence) {
    const d = track.data;
    const key = d.plate ? `plate:${d.plate}` : `unreadable:${track.uid}`;
    if (!this.plateDedup.shouldEmit(key)) return;
    let snap = null;
    let make = null;
    if (d.plate) {
      try {
        snap = this._vehicleSnapshot(track.box);
        if (snap && this.makeClassifier?.ready) make = await this.makeClassifier.classify(snap.canvas).catch(() => null);
      } catch (e) {
        console.error('Araç görüntüsü alınamadı', e);
      }
    }
    this.dispatchEvent(new CustomEvent('detection', {
      detail: {
        kind: 'plate',
        result: d.result.key,
        label: d.result.label,
        trackId: track.id,
        plate: d.plate ?? null,
        plateFormatted: d.plateFormatted ?? null,
        confidence: Math.round(confidence * 100),
        vehicleId: vehicle?.id ?? null,
        owner: vehicle?.owner ?? null,
        company: vehicle?.company ?? null,
        description: vehicle?.description ?? null,
        brand: vehicle?.brand || make?.brand || null,
        model: vehicle?.model || make?.model || null,
        color: vehicle?.color || snap?.color || null,
        vehicleType: vehicle?.vehicleType || snap?.vehicleType || null,
        thumb: this.settings.storePlateThumbnails ? d.thumb : null,
        vehiclePhoto: snap?.photo || null,
        detectedMake: make,
      },
    }));
  }

  _relieveMemory() {
    // Takip dışı kalan verileri bırak, deduplikasyon tablolarını küçült
    for (const t of this.plateTracker.tracks) {
      if (t.payload) { t.payload.ocrBlob = null; }
    }
    for (const t of this.faceTracker.tracks) {
      if (t.data.consensus && t.data.decided) t.data.consensus.votes.splice(0, Math.max(0, t.data.consensus.votes.length - 4));
    }
  }

  /** UI için özet sayaçlar */
  counts() {
    return {
      faces: this.faceTracker.confirmedCount,
      plates: this.plateTracker.tracks.filter((t) => t.confirmed && !t.data.rejected).length,
      vehicles: this.vehicleTracker.confirmedCount,
    };
  }
}
