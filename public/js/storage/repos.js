/**
 * Kayıt depoları: personel, araç, olay, işlem kaydı (audit).
 * Tüm içerik DEK ile AES-GCM şifreli saklanır; bellekte yalnızca oturum açıkken çözülmüş hâli tutulur.
 */
import { db, getMeta, setMeta } from './db.js';
import { encryptJson, decryptJson, encryptBytes, decryptBytes, sha256Hex } from './crypto.js';
import { currentDek, currentUser, requirePermission } from './auth.js';
import { plateKey, isValidTurkishPlate, formatPlate } from '../ocr/turkish-plate.js';

export const DEFAULT_SETTINGS = {
  eventRetentionDays: 30,
  auditRetentionDays: 365,
  storePlateThumbnails: true,
  dedupSeconds: 60,
  faceMatchThreshold: 0.45,     // Öklid mesafesi; düşük = daha katı
  faceMatchMargin: 0.06,        // en iyi ve ikinci en iyi aday arası en az fark
  faceMinSizePx: 72,            // kimlik doğrulama için en küçük yüz genişliği
  faceMinScore: 0.75,           // yüz algılama güven eşiği (doğrulama için)
  faceVerifyVotes: 3,           // kesin kimlik için gereken tutarlı kare sayısı
  plateMinOcrConf: 0.4,         // tek kare OCR güveni alt sınırı (ortalama)
  plateVotes: 3,                // kesin sonuç için aynı metnin okunduğu en az kare
  allowedForeignLetters: false,
  autoLockMinutes: 5,
  speak: false,
  sound: true,
  vibrate: true,
  detector: 'tiny',             // 'tiny' (hızlı) | 'ssd' (daha doğru)
  faceInputSize: 416,
  longRangeTiles: false,        // uzak mesafe için 2'li karo analizi
  resolution: '1080p',          // 720p | 1080p | 1440p | 2160p
  targetFps: 12,
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await getMeta('settings')) || {}) };
}

export async function saveSettings(patch) {
  requirePermission('settings');
  const s = { ...(await getSettings()), ...patch };
  await setMeta('settings', s);
  await audit('settings.update', 'settings', patch);
  return s;
}

/* ---------------------------------------------------------------- AUDIT */

let auditQueue = Promise.resolve();

/**
 * İşlem kaydı ekler. Kayıtlar hash zinciri ile birbirine bağlanır; bir kaydın silinmesi
 * veya değiştirilmesi zincir doğrulamasında tespit edilir.
 */
export function audit(action, target, details = {}) {
  auditQueue = auditQueue.then(async () => {
    const user = currentUser();
    const ts = Date.now();
    const enc = await encryptJson(currentDek(), {
      action, target, details, user: user?.username ?? 'sistem', role: user?.role ?? '-',
    });
    const prev = (await getMeta('auditHead')) || 'GENESIS';
    const hash = await sha256Hex(prev + ts + enc.iv + enc.ct);
    await db.put('audit', { id: crypto.randomUUID(), ts, enc, prev, hash });
    await setMeta('auditHead', hash);
  }).catch((e) => console.error('audit', e));
  return auditQueue;
}

export async function listAudit(limit = 200) {
  requirePermission('audit');
  const rows = await db.latest('audit', limit);
  const dek = currentDek();
  return Promise.all(rows.map(async (r) => ({ id: r.id, ts: r.ts, hash: r.hash, ...(await decryptJson(dek, r.enc)) })));
}

/** Hash zincirini doğrular. Saklama süresiyle silinen ilk kayıtlar zincir başlangıcını kaydırır. */
export async function verifyAuditChain() {
  const rows = (await db.getAll('audit')).sort((a, b) => a.ts - b.ts);
  let broken = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const h = await sha256Hex(r.prev + r.ts + r.enc.iv + r.enc.ct);
    if (h !== r.hash) broken++;
    if (i > 0 && rows[i - 1].hash !== r.prev) broken++;
  }
  return { total: rows.length, broken, ok: broken === 0 };
}

/* ------------------------------------------------------------ PERSONEL */

let personnelCache = null;

export async function loadPersonnel() {
  const dek = currentDek();
  const rows = await db.getAll('personnel');
  personnelCache = [];
  for (const r of rows) {
    try {
      personnelCache.push({ id: r.id, updatedAt: r.updatedAt, ...(await decryptJson(dek, r.enc)) });
    } catch (e) {
      console.error('Personel kaydı çözülemedi', r.id, e);
    }
  }
  return personnelCache;
}

export function personnel() {
  return personnelCache || [];
}

function validatePersonnel(p) {
  if (!p.employeeNo?.trim()) throw new Error('Personel numarası zorunludur.');
  if (!p.fullName?.trim()) throw new Error('Ad-soyad zorunludur.');
  if (!['authorized', 'unauthorized'].includes(p.status)) throw new Error('Yetki durumu seçilmelidir.');
  if (p.descriptors?.length && !p.consent?.informed) {
    throw new Error('Biyometrik şablon için aydınlatma yapıldığı ve hukuki dayanak onayı zorunludur.');
  }
  if (p.descriptors?.length && !p.consent?.legalBasis) {
    throw new Error('Biyometrik veri işleme için hukuki dayanak belirtilmelidir.');
  }
}

export async function savePersonnel(p) {
  requirePermission('personnel');
  validatePersonnel(p);
  const list = personnel();
  const dup = list.find((x) => x.employeeNo.trim() === p.employeeNo.trim() && x.id !== p.id);
  if (dup) throw new Error('Bu personel numarası başka bir kayıtta kullanılıyor.');
  const isNew = !p.id;
  const rec = {
    employeeNo: p.employeeNo.trim(),
    fullName: p.fullName.trim(),
    department: (p.department || '').trim(),
    status: p.status,
    consent: p.consent || null,
    retentionUntil: p.retentionUntil || null,
    descriptors: (p.descriptors || []).map((d) => Array.from(d, (v) => Math.round(v * 1e5) / 1e5)),
    createdAt: p.createdAt || Date.now(),
    createdBy: p.createdBy || currentUser().username,
  };
  const id = p.id || crypto.randomUUID();
  const enc = await encryptJson(currentDek(), rec);
  await db.put('personnel', { id, enc, updatedAt: Date.now() });
  await audit(isNew ? 'personnel.create' : 'personnel.update', id, {
    employeeNo: rec.employeeNo, status: rec.status, templates: rec.descriptors.length,
  });
  await loadPersonnel();
  return id;
}

export async function deletePersonnel(id) {
  requirePermission('personnel');
  const p = personnel().find((x) => x.id === id);
  await db.delete('personnel', id);
  await audit('personnel.delete', id, { employeeNo: p?.employeeNo });
  await loadPersonnel();
}

/* ---------------------------------------------------------------- ARAÇ */

let vehicleCache = null;
let vehicleIndex = new Map();

export async function loadVehicles() {
  const dek = currentDek();
  const rows = await db.getAll('vehicles');
  vehicleCache = [];
  vehicleIndex = new Map();
  for (const r of rows) {
    try {
      const v = { id: r.id, updatedAt: r.updatedAt, ...(await decryptJson(dek, r.enc)) };
      vehicleCache.push(v);
      vehicleIndex.set(v.plateKey, v);
    } catch (e) {
      console.error('Araç kaydı çözülemedi', r.id, e);
    }
  }
  return vehicleCache;
}

export function vehicles() {
  return vehicleCache || [];
}

export function findVehicleByPlate(plate) {
  return vehicleIndex.get(plateKey(plate)) || null;
}

export async function saveVehicle(v) {
  requirePermission('vehicles');
  const key = plateKey(v.plate);
  if (!isValidTurkishPlate(key)) throw new Error('Plaka Türk plaka formatına uymuyor (örn. 34 ABC 123).');
  if (!['authorized', 'unauthorized'].includes(v.status)) throw new Error('Yetki durumu seçilmelidir.');
  const dup = findVehicleByPlate(key);
  if (dup && dup.id !== v.id) throw new Error('Bu plaka zaten kayıtlı.');
  const isNew = !v.id;
  const rec = {
    plate: formatPlate(key), plateKey: key,
    owner: (v.owner || '').trim(), company: (v.company || '').trim(),
    description: (v.description || '').trim(), status: v.status,
    validUntil: v.validUntil || null,
    createdAt: v.createdAt || Date.now(), createdBy: v.createdBy || currentUser().username,
  };
  const id = v.id || crypto.randomUUID();
  await db.put('vehicles', { id, enc: await encryptJson(currentDek(), rec), updatedAt: Date.now() });
  await audit(isNew ? 'vehicle.create' : 'vehicle.update', id, { plate: rec.plate, status: rec.status });
  await loadVehicles();
  return id;
}

export async function deleteVehicle(id) {
  requirePermission('vehicles');
  const v = vehicles().find((x) => x.id === id);
  await db.delete('vehicles', id);
  await audit('vehicle.delete', id, { plate: v?.plate });
  await loadVehicles();
}

/* ---------------------------------------------------------------- OLAY */

/**
 * @param {object} ev {kind:'plate'|'face', result, label, confidence, trackId, ...}
 * @param {Blob} [thumb] yalnızca plaka küçük resmi (yüz görüntüsü SAKLANMAZ)
 */
export async function addEvent(ev, thumb) {
  const dek = currentDek();
  const ts = Date.now();
  const row = { id: crypto.randomUUID(), ts, kind: ev.kind, enc: await encryptJson(dek, ev) };
  if (thumb && ev.kind === 'plate') {
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    row.thumb = await encryptBytes(dek, bytes);
  }
  await db.put('events', row);
  return { id: row.id, ts, ...ev, hasThumb: !!row.thumb };
}

export async function listEvents(limit = 100) {
  const dek = currentDek();
  const rows = await db.latest('events', limit);
  const out = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, ts: r.ts, kind: r.kind, hasThumb: !!r.thumb, ...(await decryptJson(dek, r.enc)) });
    } catch { /* bozuk kayıt */ }
  }
  return out;
}

export async function eventThumbUrl(id) {
  const r = await db.get('events', id);
  if (!r?.thumb) return null;
  const bytes = await decryptBytes(currentDek(), r.thumb);
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
}

/** Görevli insan onayı: yapay zekâ sonucu tek başına güvenlik kararı değildir. */
export async function reviewEvent(id, decision, note = '') {
  const r = await db.get('events', id);
  if (!r) throw new Error('Olay bulunamadı');
  const dek = currentDek();
  const ev = await decryptJson(dek, r.enc);
  ev.review = { decision, note, by: currentUser().username, at: Date.now() };
  r.enc = await encryptJson(dek, ev);
  await db.put('events', r);
  await audit('event.review', id, { decision, kind: r.kind });
}

/* ------------------------------------------------------------ SAKLAMA */

/** Saklama politikası: süresi dolan olay, işlem kaydı ve personel kayıtlarını siler. */
export async function applyRetention() {
  const s = await getSettings();
  const now = Date.now();
  const ev = await db.deleteOlderThan('events', now - s.eventRetentionDays * 86_400_000);
  const au = await db.deleteOlderThan('audit', now - s.auditRetentionDays * 86_400_000);
  let pe = 0;
  for (const p of personnel()) {
    if (p.retentionUntil && new Date(p.retentionUntil).getTime() < now) {
      await db.delete('personnel', p.id);
      pe++;
    }
  }
  if (pe) await loadPersonnel();
  if (ev || au || pe) await audit('retention.purge', 'system', { events: ev, audit: au, personnel: pe });
  return { events: ev, audit: au, personnel: pe };
}

export async function purgeAllEvents() {
  requirePermission('settings');
  await db.clear('events');
  await audit('events.purge_all', 'events', {});
}

/** Tüm verileri şifreli olarak dışa aktarır (yedek / başka cihaza taşıma). Şifre çözülmez. */
export async function exportEncryptedBackup() {
  requirePermission('export');
  const dump = {
    format: 'guvenlik-asistani-backup', version: 1, exportedAt: Date.now(),
    users: await db.getAll('users'),
    personnel: await db.getAll('personnel'),
    vehicles: await db.getAll('vehicles'),
    meta: (await db.getAll('meta')).filter((m) => !m.key.startsWith('loginFail:')),
  };
  await audit('backup.export', 'all', { personnel: dump.personnel.length, vehicles: dump.vehicles.length });
  return new Blob([JSON.stringify(dump)], { type: 'application/json' });
}

export async function importEncryptedBackup(file) {
  requirePermission('export');
  const dump = JSON.parse(await file.text());
  if (dump.format !== 'guvenlik-asistani-backup') throw new Error('Geçersiz yedek dosyası');
  // Yedek farklı bir veri anahtarıyla şifrelenmiş olabilir: mevcut olay/işlem kayıtları
  // bu anahtarla okunamaz hale geleceğinden temizlenir, hash zinciri yeniden başlar.
  for (const store of ['users', 'personnel', 'vehicles', 'meta', 'events', 'audit']) {
    await db.clear(store);
    for (const row of dump[store] || []) {
      if (store === 'meta' && row.key === 'auditHead') continue;
      await db.put(store, row);
    }
  }
}
