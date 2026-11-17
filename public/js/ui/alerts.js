/**
 * Sesli / titreşimli uyarılar (Web Audio API + Vibration API + isteğe bağlı Türkçe sesli okuma).
 * Ses dosyası gerektirmez; tonlar anlık üretilir (çevrimdışı çalışır).
 */

const PATTERNS = {
  ok: { tones: [[880, 0.09], [1320, 0.12]], vibrate: [60] },
  danger: { tones: [[440, 0.18], [330, 0.18], [440, 0.18], [330, 0.22]], vibrate: [200, 80, 200, 80, 300] },
  info: { tones: [[660, 0.12]], vibrate: [40] },
  muted: { tones: [[520, 0.08]], vibrate: [] },
};

export class Alerts {
  constructor() {
    this.sound = true;
    this.vibrate = true;
    this.speak = false;
    this.ctx = null;
    this._lastAt = 0;
  }

  /** Tarayıcılar sesi kullanıcı etkileşimi sonrası açar; ilk dokunuşta çağrılır. */
  unlock() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* desteklenmiyor */ }
  }

  play(kind = 'info', text = '') {
    const now = Date.now();
    if (now - this._lastAt < 400) return; // ardışık uyarıları yığma
    this._lastAt = now;
    const p = PATTERNS[kind] || PATTERNS.info;
    if (this.sound && this.ctx) {
      let t = this.ctx.currentTime + 0.01;
      for (const [freq, dur] of p.tones) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = kind === 'danger' ? 'square' : 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.ctx.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
        t += dur + 0.04;
      }
    }
    if (this.vibrate && p.vibrate.length && navigator.vibrate) {
      try { navigator.vibrate(p.vibrate); } catch { /* yok say */ }
    }
    if (this.sound && this.speak && text && 'speechSynthesis' in window) {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'tr-TR';
        u.rate = 1.05;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch { /* yok say */ }
    }
  }
}
