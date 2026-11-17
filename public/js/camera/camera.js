/**
 * Kamera yöneticisi (MediaDevices API).
 *
 * - Ön/arka kamera ve belirli lens (Samsung'da tele/geniş açı ayrı deviceId olarak görünebilir) seçimi
 * - Cihazın desteklediği en uygun çözünürlüğü isteme
 * - Yakınlaştırma (zoom), fener (torch), sürekli odak/pozlama gibi gelişmiş kısıtlar
 * - Bağlantı kopması, izin reddi, cihaz meşgul gibi hataların anlaşılır mesajlara çevrilmesi
 */

export const RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
};

export class CameraError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function translateError(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return new CameraError('denied', 'Kamera izni verilmedi. Tarayıcı adres çubuğundaki kilit simgesinden kamera iznini açın.');
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') {
    return new CameraError('notfound', 'Uygun kamera bulunamadı. Başka bir kamera veya daha düşük çözünürlük seçin.');
  }
  if (n === 'NotReadableError' || n === 'AbortError') {
    return new CameraError('busy', 'Kamera başka bir uygulama tarafından kullanılıyor olabilir. Diğer kamera uygulamalarını kapatın.');
  }
  return new CameraError('unknown', `Kamera açılamadı: ${err?.message || err}`);
}

export class CameraManager extends EventTarget {
  constructor(videoEl) {
    super();
    this.video = videoEl;
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
    this.deviceId = null;
    this.resolution = '1080p';
    this.capabilities = {};
    this.settings = {};
    this._restartAttempts = 0;
  }

  static isSupported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  static isSecureContext() {
    return window.isSecureContext;
  }

  async listCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Kamera ${i + 1}`,
      }));
    } catch {
      return [];
    }
  }

  get isRunning() {
    return (!!this.track && this.track.readyState === 'live') || (this.isFile && !!this.fileUrl);
  }

  /**
   * Kayıtlı video dosyasını canlı kaynak gibi oynatır (kamera izni olmayan ortamlar ve
   * çekilmiş görüntülerin sonradan incelenmesi için). Video döngüde oynatılır.
   */
  async startFile(file) {
    this.stop();
    this.fileUrl = URL.createObjectURL(file);
    this.fileName = file.name || 'video';
    this.isFile = true;
    const v = this.video;
    v.srcObject = null;
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    v.src = this.fileUrl;
    await new Promise((resolve, reject) => {
      v.addEventListener('loadeddata', resolve, { once: true });
      v.addEventListener('error', () => reject(new CameraError('file', 'Video açılamadı. MP4 veya WebM biçiminde bir video seçin.')), { once: true });
      setTimeout(resolve, 8000);
    });
    await v.play().catch(() => {});
    this.dispatchEvent(new CustomEvent('started', { detail: this.info() }));
    return this.info();
  }

  get isFront() {
    return this.settings.facingMode === 'user' || (!this.settings.facingMode && this.facing === 'user');
  }

  async start({ facing, deviceId, resolution } = {}) {
    if (!CameraManager.isSupported()) throw new CameraError('unsupported', 'Bu tarayıcı kamera erişimini desteklemiyor.');
    if (!CameraManager.isSecureContext()) {
      throw new CameraError('insecure', 'Kamera yalnızca HTTPS bağlantısında çalışır. Uygulamayı https:// adresinden açın.');
    }
    if (facing) { this.facing = facing; this.deviceId = null; }
    if (deviceId !== undefined) this.deviceId = deviceId;
    if (resolution) this.resolution = resolution;
    this.stop();

    const res = RESOLUTIONS[this.resolution] || RESOLUTIONS['1080p'];
    const video = {
      width: { ideal: res.width },
      height: { ideal: res.height },
      frameRate: { ideal: 30, max: 30 },
    };
    if (this.deviceId) video.deviceId = { exact: this.deviceId };
    else video.facingMode = { ideal: this.facing };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      // Yüksek çözünürlük reddedildiyse kademeli olarak düşür
      if (err?.name === 'OverconstrainedError' || err?.name === 'NotReadableError') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
        } catch (err2) {
          throw translateError(err2);
        }
      } else {
        throw translateError(err);
      }
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => this._onEnded());
    this.track.addEventListener('mute', () => this.dispatchEvent(new CustomEvent('mute')));
    this.track.addEventListener('unmute', () => this.dispatchEvent(new CustomEvent('unmute')));

    this.capabilities = this.track.getCapabilities?.() || {};
    await this._applyBestDefaults();
    this.settings = this.track.getSettings?.() || {};

    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play().catch(() => {});
    await new Promise((r) => {
      if (this.video.readyState >= 2 && this.video.videoWidth) return r();
      this.video.addEventListener('loadeddata', r, { once: true });
      setTimeout(r, 3000);
    });
    this._restartAttempts = 0;
    this.dispatchEvent(new CustomEvent('started', { detail: this.info() }));
    return this.info();
  }

  /** Netlik ve hareket bulanıklığı için en uygun sürekli odak/pozlama ayarları */
  async _applyBestDefaults() {
    const c = this.capabilities;
    const adv = {};
    if (c.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
    if (c.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
    if (c.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
    if (Object.keys(adv).length) {
      try { await this.track.applyConstraints({ advanced: [adv] }); } catch { /* desteklenmiyor */ }
    }
  }

  info() {
    if (this.isFile) {
      return {
        width: this.video.videoWidth, height: this.video.videoHeight, frameRate: 0, facingMode: 'environment',
        label: `Video dosyası: ${this.fileName}`, zoomRange: null, torch: false, torchOn: false, isFile: true,
      };
    }
    const s = this.track?.getSettings?.() || {};
    this.settings = s;
    return {
      width: s.width || this.video.videoWidth,
      height: s.height || this.video.videoHeight,
      frameRate: s.frameRate,
      facingMode: s.facingMode || this.facing,
      deviceId: s.deviceId,
      label: this.track?.label || '',
      zoom: s.zoom,
      zoomRange: this.capabilities.zoom ? { min: this.capabilities.zoom.min, max: this.capabilities.zoom.max, step: this.capabilities.zoom.step } : null,
      torch: !!this.capabilities.torch,
      torchOn: !!s.torch,
      exposureCompensation: this.capabilities.exposureCompensation || null,
    };
  }

  async setZoom(z) {
    if (!this.capabilities.zoom) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: z }] });
      return true;
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    if (!this.capabilities.torch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch {
      return false;
    }
  }

  /** Düşük ışıkta pozlama telafisini artırır */
  async setExposureCompensation(v) {
    if (!this.capabilities.exposureCompensation) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ exposureCompensation: v }] });
      return true;
    } catch {
      return false;
    }
  }

  async switchFacing() {
    return this.start({ facing: this.facing === 'environment' ? 'user' : 'environment' });
  }

  async _onEnded() {
    this.dispatchEvent(new CustomEvent('lost'));
    // Kamera bağlantısı koptu: birkaç kez otomatik yeniden bağlanmayı dene
    if (this._stopping) return;
    while (this._restartAttempts < 5 && !this._stopping) {
      this._restartAttempts++;
      await new Promise((r) => setTimeout(r, 800 * this._restartAttempts));
      try {
        await this.start();
        this.dispatchEvent(new CustomEvent('recovered'));
        return;
      } catch { /* tekrar dene */ }
    }
    this.dispatchEvent(new CustomEvent('failed'));
  }

  stop() {
    this._stopping = true;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.track = null;
    if (this.video) {
      this.video.srcObject = null;
      if (this.isFile) { this.video.removeAttribute('src'); this.video.load(); }
    }
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = null;
    this.isFile = false;
    this._stopping = false;
  }
}
