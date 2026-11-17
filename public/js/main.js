/**
 * Uygulama giriş noktası ve arayüz denetleyicisi.
 */
import { $, $$, esc, toast, fmtTime, formData, fillForm, confirmBox, passwordBox, download } from './ui/dom.js';
import { requestPersistence, storageEstimate } from './storage/db.js';
import * as auth from './storage/auth.js';
import * as repo from './storage/repos.js';
import { CameraManager } from './camera/camera.js';
import { FaceEngine } from './detection/face-engine.js';
import { YoloDetector, COCO_VEHICLE_CLASSES } from './detection/yolo-detector.js';
import { PlateOcr } from './ocr/plate-ocr.js';
import { Analyzer } from './pipeline/analyzer.js';
import { Overlay } from './ui/overlay.js';
import { Alerts } from './ui/alerts.js';
import { formatPlate } from './ocr/turkish-plate.js';

const VEHICLE_MODEL = new URL('../models/vehicle/yolov8n-416.onnx', import.meta.url).href;
const PLATE_MANIFEST = new URL('../models/plate/manifest.json', import.meta.url).href;

const state = {
  settings: { ...repo.DEFAULT_SETTINGS },
  models: { face: 'bekliyor', recognition: 'bekliyor', ocr: 'bekliyor', vehicle: 'bekliyor', plateModel: 'bekliyor' },
  face: null, ocr: null, vehicle: null, plateModel: null, plateWorker: null,
  camera: null, analyzer: null, overlay: null, alerts: new Alerts(),
  tab: 'live',
  unreviewed: 0,
  modelsLoaded: false,
  adminUnlockedAt: 0,
};

/* =========================================================== BAŞLATMA */

function step(text, status = 'run') {
  const ul = $('#boot-steps');
  let li = [...ul.children].find((x) => x.dataset.k === text);
  if (!li) {
    li = document.createElement('li');
    li.dataset.k = text;
    li.textContent = text;
    ul.appendChild(li);
  }
  li.className = status;
  $('#boot-msg').textContent = status === 'run' ? text : $('#boot-msg').textContent;
}

async function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    // Service worker COOP/COEP başlıklarını ekleyerek çoklu iş parçacıklı WASM'ı etkinleştirir.
    // İlk kurulumda sayfa henüz izole değildir → bir kez yenile.
    if (!self.crossOriginIsolated && navigator.serviceWorker.controller === null) {
      if (!sessionStorage.getItem('coi-reload')) {
        sessionStorage.setItem('coi-reload', '1');
        location.reload();
        return 'reloading';
      }
    }
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Yeni sürüm hazır. Uygulamayı yeniden başlattığınızda etkinleşecek.', 'info', 6000);
        }
      });
    });
  } catch (e) {
    console.warn('Service worker kaydedilemedi', e);
  }
}

async function boot() {
  window.addEventListener('error', (e) => console.error('Genel hata', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('İşlenmemiş hata', e.reason));
  if ((await registerSw()) === 'reloading') return;
  updateNetStatus();
  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);

  if (!window.isSecureContext) {
    toast('Uyarı: Güvenli bağlantı (HTTPS) yok. Kamera ve şifreleme çalışmaz.', 'error', 10000);
  }
  if (!crypto?.subtle) {
    $('#boot-msg').textContent = 'Bu tarayıcı şifreleme (Web Crypto) desteklemiyor. HTTPS üzerinden güncel Chrome ile açın.';
    return;
  }
  requestPersistence();
  await showAuth();
}

function updateNetStatus() {
  const el = $('#net-status');
  if (!el) return;
  el.textContent = navigator.onLine ? 'Çevrimiçi' : 'Çevrimdışı';
  el.classList.toggle('offline', !navigator.onLine);
}

/* ============================================================ OTURUM */

async function showAuth() {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#auth').hidden = false;
  const setup = !(await auth.isSetupDone());
  $('#setup-form').hidden = !setup;
  $('#login-form').hidden = setup;
  (setup ? $('#setup-form [name=password]') : $('#login-form [name=username]')).focus();
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const err = $('[data-error]', e.target);
  err.textContent = '';
  if (f.password !== f.password2) { err.textContent = 'Parolalar eşleşmiyor.'; return; }
  try {
    await auth.setupAdmin(f.username.trim(), f.password);
    await repo.audit('system.setup', 'admin', { username: f.username.trim() });
    e.target.reset();
    await afterLogin();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const err = $('[data-error]', e.target);
  err.textContent = '';
  const btn = $('button', e.target);
  btn.disabled = true;
  try {
    await auth.login(f.username.trim(), f.password);
    await repo.audit('auth.login', auth.currentUser().id, {});
    e.target.reset();
    await afterLogin();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

async function afterLogin() {
  state.alerts.unlock();
  state.settings = await repo.getSettings();
  await repo.loadPersonnel();
  await repo.loadVehicles();
  repo.applyRetention().catch((e) => console.error(e));
  $('#auth').hidden = true;
  if (!state.modelsLoaded) {
    $('#boot').hidden = false;
    await loadModels();
    state.modelsLoaded = true;
    $('#boot').hidden = true;
  }
  $('#app').hidden = false;
  applyRoleUi();
  applySettingsToRuntime();
  renderAll();
  switchTab('live');
  state.adminUnlockedAt = Date.now();
}

async function lock(reason = '') {
  stopCamera();
  if (auth.isLoggedIn()) await repo.audit('auth.logout', auth.currentUser().id, { reason });
  auth.logout();
  $('#recent-list').innerHTML = '';
  await showAuth();
  if (reason) toast(reason, 'warn');
}

$('#user-chip').addEventListener('click', async () => {
  if (await confirmBox('Oturum kapatılsın mı? Canlı analiz durdurulacak.', 'Oturumu kapat')) lock();
});

function applyRoleUi() {
  const u = auth.currentUser();
  $('#user-chip').textContent = `${u.username} · ${auth.ROLES[u.role].label}`;
  for (const b of $$('#tabbar [data-perm]')) b.hidden = !auth.can(b.dataset.perm);
  for (const s of $$('[data-admin]')) s.hidden = u.role !== 'admin';
}

// Hareketsizlik kilidi: yönetim ekranları belirli süre sonra parola ister,
// kamera kapalıyken tüm oturum kilitlenir.
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => { auth.touch(); state.alerts.unlock(); }, { passive: true });
}
setInterval(() => {
  if (!auth.isLoggedIn()) return;
  const limit = (state.settings.autoLockMinutes || 5) * 60_000;
  if (auth.idleMs() > limit) {
    if (!state.camera?.isRunning) lock('Hareketsizlik nedeniyle oturum kilitlendi.');
    else if (['personnel', 'vehicles', 'settings'].includes(state.tab)) switchTab('live');
  }
}, 15_000);

async function ensureAdminFresh() {
  const limit = (state.settings.autoLockMinutes || 5) * 60_000;
  if (Date.now() - state.adminUnlockedAt < limit && auth.idleMs() < limit) return true;
  const pw = await passwordBox('Yönetim ekranı için parolanızı tekrar girin.');
  if (!pw) return false;
  try {
    const u = auth.currentUser();
    await auth.login(u.username, pw);
    state.adminUnlockedAt = Date.now();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/* ========================================================= MODELLER */

async function loadModels() {
  const onp = (t) => { $('#boot-msg').textContent = t; };

  step('Yüz algılama modeli');
  state.face = new FaceEngine();
  try {
    await state.face.load(onp);
    state.models.face = `hazır (${state.face.backend})`;
    state.models.recognition = state.face.recognitionReady ? 'hazır' : 'yüklenemedi';
    step('Yüz algılama modeli', 'done');
  } catch (e) {
    console.error(e);
    state.models.face = `yüklenemedi: ${e.message}`;
    step('Yüz algılama modeli', 'fail');
  }

  step('Plaka OCR motoru');
  state.ocr = new PlateOcr();
  try {
    const workers = (navigator.hardwareConcurrency || 4) >= 8 ? 2 : 1;
    await state.ocr.load(onp, { workers });
    state.models.ocr = `hazır (${workers} worker)`;
    step('Plaka OCR motoru', 'done');
  } catch (e) {
    console.error(e);
    state.models.ocr = `yüklenemedi: ${e.message}`;
    step('Plaka OCR motoru', 'fail');
  }

  step('Araç algılama modeli');
  try {
    state.vehicle = new YoloDetector({ url: VEHICLE_MODEL, inputSize: 416, classes: COCO_VEHICLE_CLASSES });
    await state.vehicle.load();
    state.models.vehicle = `hazır (WASM ${self.crossOriginIsolated ? 'çok iş parçacıklı' : 'tek iş parçacıklı'})`;
    step('Araç algılama modeli', 'done');
  } catch (e) {
    console.error(e);
    state.vehicle = null;
    state.models.vehicle = `yüklenemedi: ${e.message} — plaka araması tüm karede yapılacak`;
    step('Araç algılama modeli', 'fail');
  }

  step('Plaka tespit modeli (isteğe bağlı)');
  try {
    const pm = await fetch(PLATE_MANIFEST).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (pm?.model) {
      const url = new URL(pm.model, PLATE_MANIFEST).href;
      state.plateModel = new YoloDetector({ url, inputSize: pm.inputSize || 416, classes: pm.classes || { 0: 'Plaka' } });
      await state.plateModel.load();
      state.models.plateModel = 'hazır (YOLO plaka modeli)';
    } else {
      state.models.plateModel = 'yok — yerleşik plaka bulucu kullanılıyor';
    }
    step('Plaka tespit modeli (isteğe bağlı)', 'done');
  } catch (e) {
    console.error(e);
    state.plateModel = null;
    state.models.plateModel = `yüklenemedi: ${e.message}`;
    step('Plaka tespit modeli (isteğe bağlı)', 'fail');
  }

  state.plateWorker = new Worker(new URL('./workers/plate-worker.js', import.meta.url), { type: 'module' });

  state.camera = new CameraManager($('#video'));
  state.analyzer = new Analyzer({
    video: $('#video'),
    face: state.face?.ready ? state.face : null,
    vehicle: state.vehicle,
    plateModel: state.plateModel,
    plateWorker: state.plateWorker,
    ocr: state.ocr?.ready ? state.ocr : null,
    registry: { personnel: repo.personnel, findVehicleByPlate: repo.findVehicleByPlate },
  });
  state.overlay = new Overlay($('#overlay'), $('#video'), state.analyzer);
  window.__analyzer = state.analyzer; // tanılama / uçtan uca testler için
  window.__app = state;
  wireAnalyzer();
  wireCamera();
}

function applySettingsToRuntime() {
  const s = state.settings;
  state.analyzer?.applySettings(s);
  const local = readLocalPrefs();
  state.alerts.sound = local.sound ?? s.sound;
  state.alerts.vibrate = s.vibrate;
  state.alerts.speak = s.speak;
  $('[data-action=sound-toggle]').classList.toggle('on', state.alerts.sound);
}

function readLocalPrefs() {
  try { return JSON.parse(localStorage.getItem('prefs') || '{}'); } catch { return {}; }
}
function writeLocalPrefs(p) {
  try { localStorage.setItem('prefs', JSON.stringify({ ...readLocalPrefs(), ...p })); } catch { /* yok say */ }
}

/* ============================================================ KAMERA */

function wireCamera() {
  const cam = state.camera;
  cam.addEventListener('lost', () => toast('Kamera bağlantısı koptu, yeniden bağlanılıyor…', 'warn'));
  cam.addEventListener('recovered', () => toast('Kamera yeniden bağlandı.', 'ok'));
  cam.addEventListener('failed', () => { toast('Kamera yeniden bağlanamadı. Kamerayı tekrar başlatın.', 'error', 8000); stopCamera(); });
  cam.addEventListener('started', (e) => updateCameraUi(e.detail));
  navigator.mediaDevices?.addEventListener?.('devicechange', () => populateCameraSelect());

  document.addEventListener('visibilitychange', () => {
    // Arka planda analiz otomatik duraklar (bkz. Analyzer._videoReady); geri gelince video oynatılır
    if (document.visibilityState === 'visible' && cam.isRunning) $('#video').play().catch(() => {});
  });

  $('#zoom').addEventListener('input', async (e) => {
    const z = Number(e.target.value);
    $('#zoom-val').textContent = `${z.toFixed(1)}×`;
    await cam.setZoom(z);
  });
  $('#btn-torch').addEventListener('click', async () => {
    const on = !cam.info().torchOn;
    if (await cam.setTorch(on)) $('#btn-torch').classList.toggle('primary', on);
  });
  $('#camera-select').addEventListener('change', async (e) => {
    try {
      await cam.start({ deviceId: e.target.value || null });
    } catch (ex) {
      toast(ex.message, 'error', 6000);
    }
  });
}

async function populateCameraSelect() {
  const sel = $('#camera-select');
  const cams = await state.camera.listCameras();
  const cur = state.camera.settings.deviceId;
  sel.innerHTML = cams.map((c) => `<option value="${esc(c.deviceId)}" ${c.deviceId === cur ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
}

function updateCameraUi(info) {
  $('#camera-extras').hidden = false;
  const zr = info.zoomRange;
  $('#zoom-wrap').hidden = !zr || zr.max <= zr.min;
  if (zr) {
    const z = $('#zoom');
    z.min = zr.min; z.max = zr.max; z.step = zr.step || 0.1; z.value = info.zoom || zr.min;
    $('#zoom-val').textContent = `${Number(z.value).toFixed(1)}×`;
  }
  $('#btn-torch').hidden = !info.torch;
  const mirror = info.facingMode === 'user';
  $('#video').classList.toggle('mirror', mirror);
  state.overlay.mirror = mirror;
  const mp = ((info.width * info.height) / 1e6).toFixed(1);
  $('#camera-info').textContent = `${info.label || 'Kamera'} · ${info.width}×${info.height} (${mp} MP) · ${Math.round(info.frameRate || 0)} fps`
    + (info.width < 1920 ? ' · Uyarı: düşük çözünürlük 10 m mesafede okumayı zorlaştırır.' : '');
  populateCameraSelect();
}

async function startCamera() {
  try {
    $('#btn-camera').disabled = true;
    await state.camera.start({ resolution: state.settings.resolution });
    $('#stage-empty').hidden = true;
    state.analyzer.start();
    state.overlay.start();
    $('#btn-camera').classList.add('running');
    $('#btn-camera span').textContent = 'Durdur';
    await repo.audit('camera.start', 'camera', { resolution: state.settings.resolution });
    acquireWakeLock();
  } catch (e) {
    toast(e.message, 'error', 8000);
  } finally {
    $('#btn-camera').disabled = false;
  }
}

function stopCamera() {
  state.analyzer?.stop();
  state.overlay?.stop();
  state.camera?.stop();
  $('#stage-empty').hidden = false;
  $('#btn-camera')?.classList.remove('running');
  if ($('#btn-camera span')) $('#btn-camera span').textContent = 'Başlat';
  $('#plate-banner').hidden = true;
  releaseWakeLock();
}

let wakeLock = null;
async function acquireWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* desteklenmiyor */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* yok say */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.camera?.isRunning) acquireWakeLock();
});

/* ======================================================== ANALİZ OLAYLARI */

const RESULT_COLOR = {
  authorized: 'ok', 'verified-authorized': 'ok',
  'registered-unauthorized': 'danger', 'verified-unauthorized': 'danger',
  'not-registered': 'info', unregistered: 'info',
  unreadable: 'muted',
};

function wireAnalyzer() {
  const a = state.analyzer;
  a.addEventListener('status', (e) => {
    for (const k of ['face', 'plate']) {
      const chip = $(`#chip-${k}`);
      chip.dataset.state = e.detail[k].state;
      $('[data-text]', chip).textContent = e.detail[k].message;
    }
  });
  a.addEventListener('warnings', (e) => {
    const w = $('#hud-warn');
    w.hidden = !e.detail.length;
    w.textContent = e.detail.join(' ');
  });
  a.addEventListener('detection', (e) => onDetection(e.detail));

  // Sayaçlar ve performans göstergesi (analizden bağımsız, düşük frekanslı)
  setInterval(() => {
    if (!a.running) return;
    const c = a.counts();
    $('#cnt-faces').textContent = c.faces;
    $('#cnt-plates').textContent = c.plates;
    $('#cnt-vehicles').textContent = c.vehicles;
    const faceConf = a.faceTracker.tracks.filter((t) => t.confirmed).map((t) => t.scoreAvg);
    $('#conf-face').textContent = faceConf.length ? `%${Math.round(Math.max(...faceConf) * 100)}` : '—';
    const plateConf = a.plateTracker.tracks.filter((t) => t.data.decided).map((t) => t.data.confidence);
    $('#conf-plate').textContent = plateConf.length ? `%${Math.round(Math.max(...plateConf) * 100)}` : '—';
    const f = a.perf.get('face'), p = a.perf.get('plate');
    $('#chip-perf').textContent = `Yüz ${f ? f.fpsEma.toFixed(0) : 0} fps · Plaka ${p ? p.fpsEma.toFixed(1) : 0} fps`;
  }, 500);
}

async function onDetection(d) {
  const color = RESULT_COLOR[d.result] || 'info';
  let saved;
  try {
    const thumb = d.thumb;
    const { thumb: _omit, ...ev } = d;
    saved = await repo.addEvent(ev, thumb);
  } catch (e) {
    console.error('Olay kaydedilemedi', e);
    saved = { ...d, ts: Date.now(), id: `tmp-${Date.now()}` };
  }
  const list = $('#recent-list');
  list.prepend(eventItem(saved, false));
  while (list.children.length > 8) list.lastChild.remove();
  if (color === 'danger') {
    state.unreviewed++;
    updateBadge();
  }

  let speech = '';
  if (d.kind === 'plate') {
    if (d.plateFormatted) {
      showBanner(d.plateFormatted, d.label + (d.owner ? ` · ${d.owner}` : '') + (d.company ? ` · ${d.company}` : ''), color);
      speech = `Plaka ${d.plateFormatted.split(' ').join(', ')}. ${d.label}`;
    }
  } else if (d.fullName) {
    speech = `${d.fullName}. ${d.label}`;
  }
  if (d.result !== 'unreadable' && d.result !== 'unregistered') state.alerts.play(color, speech);
  if (state.tab === 'events') renderEvents();
}

let bannerTimer = null;
function showBanner(plate, sub, color) {
  const b = $('#plate-banner');
  $('[data-plate]', b).textContent = plate;
  $('[data-sub]', b).textContent = sub;
  b.dataset.color = color;
  b.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; }, 8000);
}

function updateBadge() {
  const b = $('#badge-events');
  b.hidden = state.unreviewed <= 0;
  b.textContent = state.unreviewed;
}

function eventItem(ev, withReview = true) {
  const li = document.createElement('li');
  const color = RESULT_COLOR[ev.result] || 'info';
  li.className = 'event';
  li.dataset.color = color;
  let title, meta;
  if (ev.kind === 'plate') {
    title = `<div class="title plate">${esc(ev.plateFormatted || 'Okunamadı')}</div>`;
    meta = [ev.label, ev.owner, ev.company, ev.confidence ? `güven %${ev.confidence}` : ''].filter(Boolean).join(' · ');
  } else {
    title = `<div class="title">${esc(ev.fullName ? `${ev.fullName} (${ev.employeeNo})` : `Yüz ${ev.trackId || ''}`)}</div>`;
    meta = [ev.label, ev.confidence ? `güven %${ev.confidence}` : ''].filter(Boolean).join(' · ');
  }
  li.innerHTML = `<div class="ico">${ev.kind === 'plate' ? 'PLAKA' : 'YÜZ'}</div>
    <div>${title}<div class="meta">${esc(meta)}</div></div>
    <div class="meta">${esc(fmtTime(ev.ts))}</div>`;
  if (ev.hasThumb) {
    repo.eventThumbUrl(ev.id).then((url) => {
      if (url) $('.ico', li).innerHTML = `<img src="${url}" alt="Plaka görüntüsü">`;
    }).catch(() => {});
  }
  if (withReview && !String(ev.id).startsWith('tmp-')) {
    if (ev.review) {
      const dec = ev.review.decision === 'confirmed' ? 'Görevli onayladı' : 'Görevli reddetti (hatalı algılama)';
      li.insertAdjacentHTML('beforeend', `<div class="reviewed">${esc(dec)} · ${esc(ev.review.by)} · ${esc(fmtTime(ev.review.at))}</div>`);
    } else if (color !== 'muted' && !(ev.kind === 'face' && ev.result === 'unregistered')) {
      li.insertAdjacentHTML('beforeend', `<div class="review"><button class="btn" data-review="confirmed">Doğru – onayla</button><button class="btn danger" data-review="rejected">Hatalı algılama</button></div>`);
      for (const b of $$('[data-review]', li)) {
        b.addEventListener('click', async () => {
          await repo.reviewEvent(ev.id, b.dataset.review);
          if (color === 'danger') { state.unreviewed = Math.max(0, state.unreviewed - 1); updateBadge(); }
          renderEvents();
        });
      }
    }
  }
  return li;
}

/* ============================================================ SEKMELER */

async function switchTab(tab) {
  if (['personnel', 'vehicles'].includes(tab) && !auth.can(tab)) return;
  if (['personnel', 'vehicles'].includes(tab) && !(await ensureAdminFresh())) return;
  state.tab = tab;
  for (const b of $$('#tabbar button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of $$('.view')) v.hidden = v.dataset.view !== tab;
  if (tab === 'events') renderEvents();
  if (tab === 'personnel') renderPersonnel();
  if (tab === 'vehicles') renderVehicles();
  if (tab === 'settings') renderSettings();
  if (tab === 'live') state.overlay?.resize();
  window.scrollTo({ top: 0 });
}

$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});

function renderAll() {
  renderPersonnel();
  renderVehicles();
}

/* ------------------------------------------------------------- OLAYLAR */

async function renderEvents() {
  const filter = $('#events-filter').value;
  let list = await repo.listEvents(150);
  if (filter === 'plate' || filter === 'face') list = list.filter((e) => e.kind === filter);
  if (filter === 'alarm') list = list.filter((e) => RESULT_COLOR[e.result] === 'danger');
  if (filter === 'unreviewed') list = list.filter((e) => !e.review && ['danger', 'info'].includes(RESULT_COLOR[e.result]));
  const ul = $('#events-list');
  ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="muted">Kayıt yok.</li>';
  for (const ev of list) ul.appendChild(eventItem(ev, true));
  renderReport();
}

/** Görevli işaretlemelerinden doğruluk istatistikleri (hatalı eşleşme / yanlış okuma oranı) */
async function computeReport() {
  const all = await repo.listEvents(5000);
  const groups = { plate: { n: 0, ok: 0, bad: 0, unreadable: 0, conf: 0 }, face: { n: 0, ok: 0, bad: 0, conf: 0 } };
  for (const e of all) {
    const g = groups[e.kind];
    if (!g) continue;
    g.n++;
    if (e.result === 'unreadable') g.unreadable = (g.unreadable || 0) + 1;
    if (e.review?.decision === 'confirmed') g.ok++;
    if (e.review?.decision === 'rejected') g.bad++;
    g.conf += e.confidence || 0;
  }
  return { all, groups };
}

async function renderReport() {
  const { groups } = await computeReport();
  const pct = (a, b) => (b ? `%${((a / b) * 100).toFixed(1)}` : '—');
  const p = groups.plate, f = groups.face;
  const rows = [
    ['Plaka olayı', `${p.n} (okunamadı: ${p.unreadable || 0})`],
    ['Plaka – incelenen', `${p.ok + p.bad} · doğru ${p.ok} · yanlış okuma ${p.bad}`],
    ['Plaka doğruluğu', pct(p.ok, p.ok + p.bad)],
    ['Yüz olayı', `${f.n}`],
    ['Yüz – incelenen', `${f.ok + f.bad} · doğru ${f.ok} · hatalı eşleşme ${f.bad}`],
    ['Yüz doğruluğu', pct(f.ok, f.ok + f.bad)],
  ];
  $('#report-stats').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

$('[data-action=report-csv]').addEventListener('click', async () => {
  const { all } = await computeReport();
  const cols = ['zaman', 'tur', 'sonuc', 'plaka', 'personel_no', 'ad_soyad', 'guven', 'takip_no', 'inceleme', 'inceleyen', 'inceleme_zamani'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(';')];
  for (const e of all) {
    lines.push([new Date(e.ts).toISOString(), e.kind, e.label, e.plateFormatted, e.employeeNo, e.fullName, e.confidence, e.trackId,
      e.review?.decision === 'confirmed' ? 'dogru' : e.review?.decision === 'rejected' ? 'hatali' : '', e.review?.by, e.review ? new Date(e.review.at).toISOString() : ''].map(q).join(';'));
  }
  await repo.audit('events.export_csv', 'events', { rows: all.length });
  download(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `saha-testi-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`);
});
$('#events-filter').addEventListener('change', renderEvents);

/* ------------------------------------------------------------- PERSONEL */

let personnelDraft = null;

function renderPersonnel() {
  if (!auth.can('personnel')) return;
  const q = ($('#personnel-search').value || '').toLocaleLowerCase('tr');
  const list = repo.personnel()
    .filter((p) => !q || `${p.fullName} ${p.employeeNo} ${p.department}`.toLocaleLowerCase('tr').includes(q))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'tr'));
  const ul = $('#personnel-list');
  ul.innerHTML = list.length ? '' : '<li class="muted">Kayıtlı personel yok.</li>';
  for (const p of list) {
    const li = document.createElement('li');
    li.className = 'rec';
    const exp = p.retentionUntil ? ` · saklama: ${new Date(p.retentionUntil).toLocaleDateString('tr-TR')}` : '';
    li.innerHTML = `<div><div class="title">${esc(p.fullName)}</div>
      <div class="meta">No: ${esc(p.employeeNo)}${p.department ? ` · ${esc(p.department)}` : ''} · ${p.descriptors?.length || 0} şablon${esc(exp)}</div></div>
      <span class="tag ${p.status === 'authorized' ? 'ok' : 'danger'}">${p.status === 'authorized' ? 'Yetkili' : 'Yetkisiz'}</span>`;
    li.addEventListener('click', () => openPersonnel(p));
    ul.appendChild(li);
  }
}
$('#personnel-search').addEventListener('input', renderPersonnel);

function openPersonnel(p = null) {
  const d = $('#personnel-dialog');
  const f = $('#personnel-form');
  personnelDraft = p ? { ...p, descriptors: [...(p.descriptors || [])] } : { descriptors: [] };
  f.reset();
  fillForm(f, {
    id: p?.id || '', employeeNo: p?.employeeNo || '', fullName: p?.fullName || '', department: p?.department || '',
    status: p?.status || 'authorized', informed: !!p?.consent?.informed, legalBasis: p?.consent?.legalBasis || '',
    retentionUntil: p?.retentionUntil || '',
  });
  $('[data-title]', f).textContent = p ? 'Personel Kaydını Düzenle' : 'Yeni Personel Kaydı';
  $('[data-action=personnel-delete]', f).hidden = !p;
  $('[data-error]', f).textContent = '';
  updateTemplateInfo();
  d.showModal();
}

function updateTemplateInfo() {
  const n = personnelDraft.descriptors.length;
  $('#personnel-form [data-templates]').textContent = n ? `${n} yüz şablonu hazır.` : 'Şablon yok — bu kişi yalnızca kayıt olarak tutulur, yüzle doğrulanamaz.';
}

async function addPhotos(files) {
  const f = $('#personnel-form');
  const err = $('[data-error]', f);
  err.textContent = '';
  if (!f.informed.checked || !f.legalBasis.value.trim()) {
    err.textContent = 'Önce aydınlatma/hukuki dayanak onayını işaretleyin ve dayanağı belirtin.';
    return;
  }
  if (!state.face?.recognitionReady) { err.textContent = 'Yüz doğrulama modeli yüklü değil.'; return; }
  for (const file of files) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const c = document.createElement('canvas');
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const r = await state.face.enrollFromImage(c);
      personnelDraft.descriptors.push(r.descriptor);
      c.width = c.height = 0; // fotoğraf belleği hemen bırakılır, hiçbir yere kaydedilmez
      toast(`Şablon eklendi (güven %${Math.round(r.score * 100)})`, 'ok');
    } catch (e) {
      err.textContent = `${file.name}: ${e.message}`;
    } finally {
      bmp?.close?.();
    }
  }
  updateTemplateInfo();
}

$('#personnel-form [name=photo]').addEventListener('change', (e) => { addPhotos([...e.target.files]); e.target.value = ''; });
$('#personnel-form [name=capture]').addEventListener('change', (e) => { addPhotos([...e.target.files]); e.target.value = ''; });
$('#personnel-form [data-action=templates-clear]').addEventListener('click', () => {
  personnelDraft.descriptors = [];
  updateTemplateInfo();
});

$('#personnel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') { $('#personnel-dialog').close(); return; }
  const f = formData(e.target);
  const err = $('[data-error]', e.target);
  try {
    await repo.savePersonnel({
      ...personnelDraft,
      id: f.id || undefined,
      employeeNo: f.employeeNo, fullName: f.fullName, department: f.department, status: f.status,
      consent: personnelDraft.descriptors.length || f.informed ? { informed: f.informed, legalBasis: f.legalBasis.trim(), recordedAt: Date.now(), by: auth.currentUser().username } : null,
      retentionUntil: f.retentionUntil || null,
    });
    $('#personnel-dialog').close();
    renderPersonnel();
    toast('Personel kaydı kaydedildi.', 'ok');
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$('#personnel-form [data-action=personnel-delete]').addEventListener('click', async () => {
  const id = $('#personnel-form [name=id]').value;
  if (!id || !(await confirmBox('Bu personel kaydı ve tüm biyometrik şablonları kalıcı olarak silinsin mi?', 'Sil'))) return;
  await repo.deletePersonnel(id);
  $('#personnel-dialog').close();
  renderPersonnel();
  toast('Kayıt silindi.', 'ok');
});

$('[data-action=personnel-new]').addEventListener('click', () => openPersonnel(null));

/* --------------------------------------------------------------- ARAÇLAR */

function renderVehicles() {
  if (!auth.can('vehicles')) return;
  const q = ($('#vehicle-search').value || '').toLocaleUpperCase('tr').replace(/\s/g, '');
  const list = repo.vehicles()
    .filter((v) => !q || `${v.plateKey}${v.owner}${v.company}${v.description}`.toLocaleUpperCase('tr').replace(/\s/g, '').includes(q))
    .sort((a, b) => a.plateKey.localeCompare(b.plateKey));
  const ul = $('#vehicle-list');
  ul.innerHTML = list.length ? '' : '<li class="muted">Kayıtlı araç yok.</li>';
  for (const v of list) {
    const expired = v.validUntil && new Date(v.validUntil) < new Date();
    const li = document.createElement('li');
    li.className = 'rec';
    li.innerHTML = `<div><div class="title mono">${esc(v.plate)}</div>
      <div class="meta">${esc([v.owner, v.company, v.description].filter(Boolean).join(' · ') || '—')}${v.validUntil ? ` · bitiş: ${esc(new Date(v.validUntil).toLocaleDateString('tr-TR'))}` : ''}</div></div>
      <span class="tag ${v.status === 'authorized' && !expired ? 'ok' : 'danger'}">${expired ? 'Süresi doldu' : v.status === 'authorized' ? 'Yetkili' : 'Yetkisiz'}</span>`;
    li.addEventListener('click', () => openVehicle(v));
    ul.appendChild(li);
  }
}
$('#vehicle-search').addEventListener('input', renderVehicles);

function openVehicle(v = null) {
  const f = $('#vehicle-form');
  f.reset();
  fillForm(f, {
    id: v?.id || '', plate: v?.plate || '', owner: v?.owner || '', company: v?.company || '',
    description: v?.description || '', status: v?.status || 'authorized', validUntil: v?.validUntil || '',
  });
  f.dataset.createdAt = v?.createdAt || '';
  $('[data-title]', f).textContent = v ? 'Araç Kaydını Düzenle' : 'Yeni Araç Kaydı';
  $('[data-action=vehicle-delete]', f).hidden = !v;
  $('[data-error]', f).textContent = '';
  $('#vehicle-dialog').showModal();
}

$('#vehicle-form [name=plate]').addEventListener('blur', (e) => { e.target.value = formatPlate(e.target.value); });

$('#vehicle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') { $('#vehicle-dialog').close(); return; }
  const f = formData(e.target);
  try {
    await repo.saveVehicle({ ...f, id: f.id || undefined, createdAt: Number(e.target.dataset.createdAt) || undefined, validUntil: f.validUntil || null });
    $('#vehicle-dialog').close();
    renderVehicles();
    toast('Araç kaydı kaydedildi.', 'ok');
  } catch (ex) {
    $('[data-error]', e.target).textContent = ex.message;
  }
});

$('#vehicle-form [data-action=vehicle-delete]').addEventListener('click', async () => {
  const id = $('#vehicle-form [name=id]').value;
  if (!id || !(await confirmBox('Bu araç kaydı silinsin mi?', 'Sil'))) return;
  await repo.deleteVehicle(id);
  $('#vehicle-dialog').close();
  renderVehicles();
});

$('[data-action=vehicle-new]').addEventListener('click', () => openVehicle(null));

/* --------------------------------------------------------------- AYARLAR */

const SETTINGS_SCHEMA = [
  { group: 'Kamera ve performans' },
  { key: 'resolution', label: 'Kamera çözünürlüğü', type: 'select', options: [['720p', '720p (pil tasarrufu)'], ['1080p', '1080p (önerilen)'], ['1440p', '1440p (uzak mesafe)'], ['2160p', '4K (en uzak mesafe, yüksek ısınma)']] },
  { key: 'targetFps', label: 'Yüz analizi hedef FPS', type: 'number', min: 2, max: 30 },
  { key: 'detector', label: 'Yüz algılayıcı', type: 'select', options: [['tiny', 'Hızlı (TinyFaceDetector)'], ['ssd', 'Doğru (SSD MobileNet)']] },
  { key: 'faceInputSize', label: 'Yüz modeli giriş boyutu', type: 'select', options: [['320', '320 (hızlı)'], ['416', '416'], ['512', '512'], ['608', '608 (küçük yüzler)']] },
  { key: 'longRangeTiles', label: 'Uzak mesafe modu (karo analizi, 5-10 m)', type: 'checkbox' },
  { group: 'Yüz doğrulama' },
  { key: 'faceMatchThreshold', label: 'Eşleşme mesafe eşiği (düşük = katı)', type: 'number', min: 0.3, max: 0.6, step: 0.01 },
  { key: 'faceMatchMargin', label: 'Belirsizlik payı', type: 'number', min: 0, max: 0.2, step: 0.01 },
  { key: 'faceMinSizePx', label: 'Doğrulama için en küçük yüz (px)', type: 'number', min: 48, max: 200 },
  { key: 'faceMinScore', label: 'En düşük algılama güveni', type: 'number', min: 0.5, max: 0.99, step: 0.01 },
  { key: 'faceVerifyVotes', label: 'Kesin sonuç için gereken kare', type: 'number', min: 1, max: 10 },
  { group: 'Plaka okuma' },
  { key: 'plateVotes', label: 'Kesin sonuç için gereken okuma', type: 'number', min: 1, max: 6 },
  { key: 'plateMinOcrConf', label: 'En düşük OCR güveni', type: 'number', min: 0.3, max: 0.95, step: 0.05 },
  { key: 'dedupSeconds', label: 'Aynı plaka/kişi için tekrar bildirim süresi (sn)', type: 'number', min: 5, max: 3600 },
  { key: 'storePlateThumbnails', label: 'Olay kaydında plaka görüntüsünü sakla', type: 'checkbox' },
  { group: 'Uyarılar' },
  { key: 'sound', label: 'Sesli uyarı (varsayılan)', type: 'checkbox' },
  { key: 'speak', label: 'Sonucu sesli oku (Türkçe)', type: 'checkbox' },
  { key: 'vibrate', label: 'Titreşim', type: 'checkbox' },
  { group: 'Gizlilik ve saklama' },
  { key: 'eventRetentionDays', label: 'Olay kayıtları saklama süresi (gün)', type: 'number', min: 1, max: 365 },
  { key: 'auditRetentionDays', label: 'İşlem kayıtları saklama süresi (gün)', type: 'number', min: 30, max: 3650 },
  { key: 'autoLockMinutes', label: 'Otomatik kilit (dakika)', type: 'number', min: 1, max: 60 },
];

async function renderSettings() {
  const form = $('#settings-form');
  const s = state.settings;
  const isAdmin = auth.can('settings');
  form.innerHTML = SETTINGS_SCHEMA.map((f) => {
    if (f.group) return `<h3>${esc(f.group)}</h3>`;
    const dis = isAdmin ? '' : 'disabled';
    if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" name="${f.key}" ${s[f.key] ? 'checked' : ''} ${dis}>${esc(f.label)}</label>`;
    if (f.type === 'select') {
      return `<label>${esc(f.label)}<select name="${f.key}" ${dis}>${f.options.map(([v, l]) => `<option value="${v}" ${String(s[f.key]) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    }
    return `<label>${esc(f.label)}<input type="number" name="${f.key}" value="${s[f.key]}" min="${f.min}" max="${f.max}" step="${f.step || 1}" ${dis}></label>`;
  }).join('') + (isAdmin ? '<button class="btn primary" type="submit">Ayarları Kaydet</button>' : '<p class="muted tiny">Ayarları yalnızca yönetici değiştirebilir.</p>');

  if (isAdmin) {
    renderUsers();
    renderAudit();
  }
  renderDiag();
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!(await ensureAdminFresh())) return;
  const patch = {};
  for (const f of SETTINGS_SCHEMA) {
    if (!f.key) continue;
    const el = e.target.elements[f.key];
    if (f.type === 'checkbox') patch[f.key] = el.checked;
    else if (f.type === 'number') {
      const v = Number(el.value);
      if (Number.isNaN(v) || v < f.min || v > f.max) { toast(`${f.label}: ${f.min}–${f.max} aralığında olmalı`, 'error'); return; }
      patch[f.key] = v;
    } else patch[f.key] = f.key === 'faceInputSize' ? Number(el.value) : el.value;
  }
  const resChanged = patch.resolution !== state.settings.resolution;
  state.settings = await repo.saveSettings(patch);
  applySettingsToRuntime();
  toast('Ayarlar kaydedildi.', 'ok');
  if (resChanged && state.camera?.isRunning) {
    await state.camera.start({ resolution: state.settings.resolution }).catch((ex) => toast(ex.message, 'error'));
  }
});

async function renderUsers() {
  const ul = $('#users-list');
  const users = await auth.listUsers();
  const me = auth.currentUser();
  ul.innerHTML = '';
  for (const u of users) {
    const li = document.createElement('li');
    li.className = 'rec';
    li.innerHTML = `<div><div class="title">${esc(u.username)}${u.id === me.id ? ' (siz)' : ''}</div><div class="meta">${esc(auth.ROLES[u.role].label)}${u.disabled ? ' · devre dışı' : ''}</div></div>
      <div class="row">${u.id === me.id ? '' : `<button class="btn" data-act="toggle">${u.disabled ? 'Etkinleştir' : 'Devre dışı'}</button><button class="btn" data-act="reset">Parola</button><button class="btn danger" data-act="del">Sil</button>`}</div>`;
    li.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act || !(await ensureAdminFresh())) return;
      try {
        if (act === 'toggle') { await auth.setUserDisabled(u.id, !u.disabled); await repo.audit('user.toggle', u.id, { disabled: !u.disabled }); }
        if (act === 'del' && (await confirmBox(`${u.username} silinsin mi?`, 'Sil'))) { await auth.deleteUser(u.id); await repo.audit('user.delete', u.id, { username: u.username }); }
        if (act === 'reset') {
          const pw = await passwordBox(`${u.username} için yeni parola`);
          if (pw) { await auth.resetUserPassword(u.id, pw); await repo.audit('user.password_reset', u.id, {}); toast('Parola güncellendi.', 'ok'); }
        }
        renderUsers();
      } catch (ex) { toast(ex.message, 'error'); }
    });
    ul.appendChild(li);
  }
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!(await ensureAdminFresh())) return;
  const f = formData(e.target);
  try {
    const u = await auth.addUser(f.username.trim(), f.password, f.role);
    await repo.audit('user.create', u.id, { username: u.username, role: u.role });
    e.target.reset();
    renderUsers();
    toast('Kullanıcı eklendi.', 'ok');
  } catch (ex) { toast(ex.message, 'error'); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  try {
    await auth.changeOwnPassword(f.old, f.new);
    await repo.audit('user.password_change', auth.currentUser().id, {});
    e.target.reset();
    toast('Parolanız değiştirildi.', 'ok');
  } catch (ex) { toast(ex.message, 'error'); }
});

const AUDIT_LABELS = {
  'system.setup': 'Kurulum', 'auth.login': 'Giriş', 'auth.logout': 'Çıkış', 'camera.start': 'Kamera başlatıldı', 'camera.stop': 'Kamera durduruldu',
  'personnel.create': 'Personel eklendi', 'personnel.update': 'Personel güncellendi', 'personnel.delete': 'Personel silindi',
  'vehicle.create': 'Araç eklendi', 'vehicle.update': 'Araç güncellendi', 'vehicle.delete': 'Araç silindi',
  'event.review': 'Olay incelendi', 'settings.update': 'Ayarlar değişti', 'retention.purge': 'Saklama süresi dolan veriler silindi',
  'events.purge_all': 'Tüm olaylar silindi', 'backup.export': 'Yedek alındı', 'user.create': 'Kullanıcı eklendi',
  'user.delete': 'Kullanıcı silindi', 'user.toggle': 'Kullanıcı durumu', 'user.password_reset': 'Parola sıfırlandı',
  'user.password_change': 'Parola değişti', 'events.export_csv': 'Olaylar CSV dışa aktarıldı',
};

async function renderAudit() {
  const rows = await repo.listAudit(100);
  $('#audit-list').innerHTML = rows.map((r) => `<li><b>${esc(AUDIT_LABELS[r.action] || r.action)}</b> · ${esc(r.user)} · ${esc(fmtTime(r.ts))}
    <br><span class="tiny">${esc(JSON.stringify(r.details))}</span></li>`).join('') || '<li>Kayıt yok</li>';
}

$('[data-action=audit-verify]').addEventListener('click', async () => {
  const r = await repo.verifyAuditChain();
  toast(r.ok ? `İşlem kaydı zinciri sağlam (${r.total} kayıt).` : `UYARI: ${r.broken} tutarsızlık bulundu! Kayıtlar değiştirilmiş olabilir.`, r.ok ? 'ok' : 'error', 6000);
});

$('[data-action=backup-export]').addEventListener('click', async () => {
  if (!(await ensureAdminFresh())) return;
  const blob = await repo.exportEncryptedBackup();
  download(blob, `guvenlik-yedek-${new Date().toISOString().slice(0, 10)}.json`);
});

$('#backup-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !(await ensureAdminFresh())) return;
  if (!(await confirmBox('Mevcut tüm kayıtlar silinip yedekteki kayıtlar yüklenecek. Yedekteki kullanıcı parolalarıyla yeniden giriş yapmanız gerekecek. Devam edilsin mi?', 'Geri yükle'))) return;
  try {
    await repo.importEncryptedBackup(file);
    toast('Yedek yüklendi. Lütfen yeniden giriş yapın.', 'ok');
    lock();
  } catch (ex) { toast(ex.message, 'error'); }
});

$('[data-action=retention-run]').addEventListener('click', async () => {
  const r = await repo.applyRetention();
  toast(`Silinen: ${r.events} olay, ${r.audit} işlem kaydı, ${r.personnel} personel kaydı.`, 'ok');
  renderPersonnel();
});

$('[data-action=events-purge]').addEventListener('click', async () => {
  if (!(await ensureAdminFresh())) return;
  if (!(await confirmBox('Tüm algılama kayıtları kalıcı olarak silinsin mi?', 'Tümünü sil'))) return;
  await repo.purgeAllEvents();
  state.unreviewed = 0; updateBadge();
  toast('Olay kayıtları silindi.', 'ok');
});

async function renderDiag() {
  const a = state.analyzer;
  const est = await storageEstimate();
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const mem = a?.perf.memoryInfo();
  const tfm = state.face?.memory();
  const ms = (k) => { const s = a?.perf.get(k); return s ? `${s.ema.toFixed(0)} ms` : '—'; };
  const info = state.camera?.isRunning ? state.camera.info() : null;
  const rows = [
    ['Yüz algılama', state.models.face],
    ['Yüz doğrulama', state.models.recognition],
    ['Plaka OCR', state.models.ocr],
    ['Araç algılama', state.models.vehicle],
    ['Plaka modeli', state.models.plateModel],
    ['Çapraz köken izolasyonu', self.crossOriginIsolated ? 'etkin (çok iş parçacığı)' : 'yok (tek iş parçacığı)'],
    ['İşlemci çekirdeği', navigator.hardwareConcurrency || '?'],
    ['Kamera', info ? `${info.width}×${info.height} · ${info.label}` : 'kapalı'],
    ['Süreler', `yüz ${ms('face')} · şablon ${ms('faceDescribe')} · plaka ${ms('plate')} · OCR ${ms('ocr')}`],
    ['İşlemci baskısı', a?.perf.pressure || '—'],
    ['JS bellek', mem ? `${mem.usedMB} / ${mem.limitMB} MB` : '—'],
    ['TF.js tensör', tfm ? `${tfm.numTensors} tensör · ${(tfm.numBytes / 1048576).toFixed(1)} MB` : '—'],
    ['Depolama', est ? `${(est.usage / 1048576).toFixed(1)} MB / ${(est.quota / 1048576).toFixed(0)} MB${persisted ? ' · kalıcı' : ''}` : '—'],
    ['Kayıtlar', `${repo.personnel().length} personel · ${repo.vehicles().length} araç`],
  ];
  $('#diag').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

/* ========================================================= CANLI KONTROLLER */

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const act = b.dataset.action;
  if (act === 'camera-toggle') {
    state.alerts.unlock();
    if (state.camera?.isRunning) { stopCamera(); await repo.audit('camera.stop', 'camera', {}); } else await startCamera();
  } else if (act === 'flip') {
    if (!state.camera) return;
    try {
      state.analyzer.faceTracker.reset();
      state.analyzer.plateTracker.reset();
      if (state.camera.isRunning) await state.camera.switchFacing();
      else state.camera.facing = state.camera.facing === 'environment' ? 'user' : 'environment';
      toast(state.camera.facing === 'user' ? 'Ön kamera' : 'Arka kamera');
    } catch (ex) { toast(ex.message, 'error'); }
  } else if (act === 'face-toggle') {
    state.analyzer.faceEnabled = !state.analyzer.faceEnabled;
    b.classList.toggle('on', state.analyzer.faceEnabled);
    if (!state.analyzer.faceEnabled) state.analyzer.faceTracker.reset();
  } else if (act === 'plate-toggle') {
    state.analyzer.plateEnabled = !state.analyzer.plateEnabled;
    b.classList.toggle('on', state.analyzer.plateEnabled);
    if (!state.analyzer.plateEnabled) { state.analyzer.plateTracker.reset(); state.analyzer.vehicleTracker.reset(); }
  } else if (act === 'sound-toggle') {
    state.alerts.sound = !state.alerts.sound;
    state.alerts.unlock();
    b.classList.toggle('on', state.alerts.sound);
    writeLocalPrefs({ sound: state.alerts.sound });
    if (state.alerts.sound) state.alerts.play('info');
  }
});

boot().catch((e) => {
  console.error(e);
  $('#boot-msg').textContent = `Başlatma hatası: ${e.message}`;
});
