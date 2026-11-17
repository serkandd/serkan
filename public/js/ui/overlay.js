/**
 * Canlı görüntü üzerine algılama çerçevelerini çizen katman.
 *
 * - Analizden bağımsız kendi requestAnimationFrame döngüsünde çalışır; takipçilerin
 *   öngörülen kutularını çizerek analiz kareleri arasında da akıcı hareket sağlar.
 * - Video koordinatlarını ekran koordinatlarına `object-fit: contain` kurallarıyla eşler;
 *   ekran döndürme / yeniden boyutlandırmada (ResizeObserver) kutular kaymaz.
 * - Yüksek DPI ekranlarda keskin çizim için devicePixelRatio kullanılır.
 * - Ön kamerada ayna görüntüsüne göre kutular yatayda çevrilir.
 */

const COLORS = {
  ok: '#22c55e',
  danger: '#ef4444',
  info: '#38bdf8',
  muted: '#f59e0b',
  face: '#a78bfa',
  vehicle: 'rgba(226,232,240,0.55)',
};

export class Overlay {
  constructor(canvas, video, analyzer) {
    this.canvas = canvas;
    this.video = video;
    this.analyzer = analyzer;
    this.ctx = canvas.getContext('2d');
    this.mirror = false;
    this.running = false;
    this.showVehicles = true;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = r.width;
    this.cssH = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** video piksel → CSS piksel dönüşümü (object-fit: contain) */
  mapping() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(this.cssW / vw, this.cssH / vh);
    return { s, ox: (this.cssW - vw * s) / 2, oy: (this.cssH - vh * s) / 2, vw, vh };
  }

  toScreen(box, m) {
    let x = box.x;
    if (this.mirror) x = m.vw - box.x - box.w;
    return { x: m.ox + x * m.s, y: m.oy + box.y * m.s, w: box.w * m.s, h: box.h * m.s };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.ctx.clearRect(0, 0, this.cssW, this.cssH);
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const m = this.mapping();
    if (!m || !this.analyzer) return;
    const now = performance.now();

    if (this.showVehicles) {
      for (const { track, box } of this.analyzer.vehicleTracker.snapshot(now)) {
        const r = this.toScreen(box, m);
        ctx.strokeStyle = COLORS.vehicle;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        this.label(r.x, r.y, `${track.id} ${track.payload?.label || 'Araç'}`, 'rgba(15,23,42,0.6)', '#e2e8f0', 11);
      }
    }

    for (const { track, box, stale } of this.analyzer.faceTracker.snapshot(now)) {
      const r = this.toScreen(box, m);
      const res = track.data.result;
      const color = res ? (COLORS[res.color] || COLORS.face) : COLORS.face;
      const fade = stale ? 0.45 : 1;
      ctx.globalAlpha = fade;
      this.corners(r, color, 3);
      const pct = Math.round(track.scoreAvg * 100);
      let title = `${track.id} · Yüz %${pct}`;
      let sub = res?.label || '';
      if (track.data.person && track.data.decided) {
        title = `${track.id} · ${track.data.person.fullName}`;
        sub = `${res.label} · %${Math.round((track.data.confidence || 0) * 100)}`;
      }
      // Tanınan kişinin adı büyük yazılır
      this.label(r.x, r.y, title, color, '#0b1220', track.data.person && track.data.decided ? 17 : 13);
      if (sub) this.label(r.x, r.y + r.h + 2, sub, 'rgba(15,23,42,0.85)', '#f8fafc', 11, true);
      ctx.globalAlpha = 1;
    }

    for (const { track, box, stale } of this.analyzer.plateTracker.snapshot(now)) {
      const d = track.data;
      if (d.rejected) continue; // plakaya benzemeyen aday (tabela, desen vb.)
      const r = this.toScreen(box, m);
      const color = d.result ? COLORS[d.result.color] : COLORS.muted;
      ctx.globalAlpha = stale ? 0.45 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      if (!d.decided) ctx.setLineDash([8, 5]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      if (d.decided && d.plateFormatted) {
        this.label(r.x, r.y + r.h + 4, d.plateFormatted, color, '#0b1220', Math.max(16, Math.min(30, r.h * 0.9)), true);
        this.label(r.x, r.y, `${track.id} · ${d.result.label} · %${Math.round(d.confidence * 100)}`, 'rgba(15,23,42,0.85)', '#f8fafc', 11);
      } else if (d.unreadable) {
        this.label(r.x, r.y, `${track.id} · Plaka okunamadı`, 'rgba(15,23,42,0.85)', '#fbbf24', 11);
      } else {
        const hint = d.hint ? ` · ${d.hint}` : d.attempts ? ' · okunuyor…' : '';
        this.label(r.x, r.y, `${track.id} · Plaka adayı${hint}`, 'rgba(15,23,42,0.75)', '#fde68a', 11);
      }
      ctx.globalAlpha = 1;
    }
  }

  corners(r, color, lw) {
    const ctx = this.ctx;
    const l = Math.max(10, Math.min(r.w, r.h) * 0.25);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + l); ctx.lineTo(r.x, r.y); ctx.lineTo(r.x + l, r.y);
    ctx.moveTo(r.x + r.w - l, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + l);
    ctx.moveTo(r.x + r.w, r.y + r.h - l); ctx.lineTo(r.x + r.w, r.y + r.h); ctx.lineTo(r.x + r.w - l, r.y + r.h);
    ctx.moveTo(r.x + l, r.y + r.h); ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x, r.y + r.h - l);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha *= 0.35;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha /= 0.35;
  }

  /** Etiket kutusu; ekran dışına taşmayacak şekilde konumlanır */
  label(x, y, text, bg, fg, size = 12, below = false) {
    const ctx = this.ctx;
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const pad = Math.round(size * 0.35);
    const w = ctx.measureText(text).width + pad * 2;
    const h = size + pad * 2;
    let lx = Math.max(2, Math.min(this.cssW - w - 2, x));
    let ly = below ? y : y - h - 2;
    if (ly < 2) ly = y + 2;
    if (ly + h > this.cssH - 2) ly = this.cssH - h - 2;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, ly, w, h, 4) : ctx.rect(lx, ly, w, h);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + pad, ly + h / 2 + 1);
  }
}
