/**
 * Yedekleme ve geri yükleme.
 *
 * Android uygulamasında yedek, telefonun ortak **Belgeler/GuvenlikAsistani** klasörüne otomatik yazılır.
 * Bu klasör uygulama silinse de kalır; yeniden kurulumda dosya seçilerek tüm kayıtlar geri gelir.
 *
 *   guvenlik-yedek.json            — her değişiklikten kısa süre sonra güncellenen son yedek
 *   guvenlik-yedek-<gün>.json      — haftanın her günü için bir kopya (7 günlük geçmiş)
 *
 * İçerik: kullanıcılar, personel (yüz şablonları ve küçük yüz resimleriyle), araçlar (fotoğraflarla), ayarlar.
 * Kayıtlar şifreli kalır. Veri anahtarı, PIN'siz geri yükleme yapılabilsin diye uygulamaya özgü bir
 * kurtarma anahtarıyla sarılır: dosyayı bu uygulamayla açabilen herkes kayıtlara erişebilir — yedek
 * dosyasını başkalarıyla paylaşmayın.
 */
import { db } from './db.js';
import { randomBytes, toB64, fromB64 } from './crypto.js';
import * as auth from './auth.js';

const FORMAT = 'guvenlik-asistani-backup';
const RECOVERY_SECRET = 'guvenlik-asistani/kurtarma/v1';
const FOLDER = 'GuvenlikAsistani';
const DAYS = ['pazar', 'pazartesi', 'sali', 'carsamba', 'persembe', 'cuma', 'cumartesi'];

async function recoveryKey(salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(RECOVERY_SECRET), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, base,
    { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

/** Yedek içeriğini üretir (JSON metni) */
export async function buildBackup() {
  const dek = auth.currentDek();
  const salt = randomBytes(16);
  let recovery = null;
  try {
    const wrapped = await crypto.subtle.wrapKey('raw', dek, await recoveryKey(salt), 'AES-KW');
    recovery = { salt: toB64(salt), wrapped: toB64(wrapped) };
  } catch {
    // Görevli oturumunda anahtar dışa aktarılamaz; yedek yalnızca PIN ile açılabilir
  }
  const dump = {
    format: FORMAT, version: 2, exportedAt: Date.now(), recovery,
    users: await db.getAll('users'),
    personnel: await db.getAll('personnel'),
    vehicles: await db.getAll('vehicles'),
    meta: (await db.getAll('meta')).filter((m) => !m.key.startsWith('loginFail:') && !['deviceKey', 'autoLogin', 'auditHead'].includes(m.key)),
  };
  return JSON.stringify(dump);
}

/* ------------------------------------------------ Android dosya sistemi */

let fsPlugin;
function filesystem() {
  if (fsPlugin !== undefined) return fsPlugin;
  const C = window.Capacitor;
  fsPlugin = (C?.isNativePlatform?.() && C.isPluginAvailable?.('Filesystem'))
    ? (C.registerPlugin ? C.registerPlugin('Filesystem') : C.Plugins?.Filesystem) || null
    : null;
  return fsPlugin;
}

export function autoBackupAvailable() {
  return !!filesystem();
}

export const BACKUP_LOCATION = `Belgeler/${FOLDER}/guvenlik-yedek.json`;

export async function writeBackupToDevice() {
  const fs = filesystem();
  if (!fs) throw new Error('Otomatik yedek yalnızca Android uygulamasında çalışır.');
  try { await fs.requestPermissions?.(); } catch { /* yeni Android sürümlerinde gerekmez */ }
  const data = await buildBackup();
  const write = (name) => fs.writeFile({ path: `${FOLDER}/${name}`, data, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
  await write('guvenlik-yedek.json');
  await write(`guvenlik-yedek-${DAYS[new Date().getDay()]}.json`);
  return { bytes: data.length, at: Date.now() };
}

/* ------------------------------------------------------- otomatik yedek */

let timer = null;
let lastResult = null;
export const backupStatus = () => lastResult;

/** Değişiklikten sonra kısa bir bekleme ile yedekler (art arda değişiklikler tek yedekte toplanır) */
export function scheduleBackup(delayMs = 15_000) {
  if (!autoBackupAvailable() || !auth.isLoggedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      lastResult = { ok: true, ...(await writeBackupToDevice()) };
    } catch (e) {
      lastResult = { ok: false, error: String(e?.message || e), at: Date.now() };
      console.error('Otomatik yedek yazılamadı', e);
    }
  }, delayMs);
}

/* ------------------------------------------------------------ geri yükle */

/**
 * Yedek dosyasını geri yükler. Kurtarma anahtarı varsa PIN sorulmadan oturum açılır ve bu cihazda
 * otomatik giriş etkinleşir. Mevcut kayıtlar yedektekilerle değiştirilir.
 * @returns {Promise<{autoLogin:boolean, personnel:number, vehicles:number}>}
 */
export async function restoreBackup(file) {
  let dump;
  try {
    dump = JSON.parse(await file.text());
  } catch {
    throw new Error('Dosya okunamadı. Uygulamanın oluşturduğu guvenlik-yedek.json dosyasını seçin.');
  }
  if (dump.format !== FORMAT) throw new Error('Bu dosya bir Güvenlik Asistanı yedeği değil.');

  // Önce anahtarı doğrula: başarısızsa mevcut veriye dokunma
  let dek = null;
  if (dump.recovery) {
    dek = await crypto.subtle.unwrapKey('raw', fromB64(dump.recovery.wrapped), await recoveryKey(fromB64(dump.recovery.salt)),
      'AES-KW', { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  for (const store of ['users', 'personnel', 'vehicles', 'meta', 'events', 'audit']) {
    await db.clear(store);
    for (const row of dump[store] || []) {
      if (store === 'meta' && ['auditHead', 'deviceKey', 'autoLogin'].includes(row.key)) continue;
      await db.put(store, row);
    }
  }
  let autoLogin = false;
  if (dek) {
    const admin = (dump.users || []).find((u) => u.role === 'admin' && !u.disabled);
    if (admin) {
      auth.adoptSession(admin, dek);
      await auth.enableAutoLogin();
      autoLogin = true;
    }
  }
  return { autoLogin, personnel: (dump.personnel || []).length, vehicles: (dump.vehicles || []).length };
}
