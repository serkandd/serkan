/**
 * Kimlik doğrulama ve rol yönetimi.
 *
 * Roller:
 *   admin    — Yönetici: personel/araç kayıtları, kullanıcılar, ayarlar, veri silme, dışa aktarma
 *   operator — Güvenlik görevlisi: canlı analiz, olay listesi, olay onaylama/reddetme
 *
 * Parolalar hiçbir yerde saklanmaz; yalnızca parola ile sarılmış veri anahtarı (DEK) saklanır.
 * Başarılı giriş = DEK'in çözülebilmesi. Ardışık hatalı girişlerde artan bekleme süresi uygulanır.
 */
import { db, getMeta, setMeta } from './db.js';
import { generateDek, wrapDek, unwrapDek, toB64, fromB64 } from './crypto.js';

export const ROLES = {
  admin: { label: 'Yönetici', can: ['live', 'events', 'personnel', 'vehicles', 'users', 'settings', 'audit', 'export'] },
  operator: { label: 'Güvenlik Görevlisi', can: ['live', 'events'] },
};


const session = {
  user: null,
  dek: null,
  lastActivity: 0,
};

export function currentUser() {
  return session.user;
}

export function currentDek() {
  if (!session.dek) throw new Error('Oturum kapalı');
  return session.dek;
}

export function isLoggedIn() {
  return !!session.user && !!session.dek;
}

export function can(permission) {
  return !!session.user && ROLES[session.user.role]?.can.includes(permission);
}

export function requirePermission(permission) {
  if (!can(permission)) throw new Error('Bu işlem için yetkiniz yok.');
}

export function touch() {
  session.lastActivity = Date.now();
}

export function idleMs() {
  return Date.now() - session.lastActivity;
}

export async function isSetupDone() {
  return !!(await getMeta('setup'));
}

/** Giriş yalnızca 4 haneli PIN ile yapılır. */
export const PIN_LENGTH = 4;

function validatePin(pin) {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin || '')) {
    throw new Error(`PIN ${PIN_LENGTH} rakamdan oluşmalıdır.`);
  }
}

function validateUsername(u) {
  const v = (u || '').trim();
  if (v.length < 2 || v.length > 32) throw new Error('Kullanıcı adı 2-32 karakter olmalıdır.');
}

async function findUser(username) {
  const all = await db.getAll('users');
  return all.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

/** Verilen PIN'i çözebilen kullanıcıyı bulur (yöneticiler önce denenir). */
async function userForPin(pin, { includeDisabled = false } = {}) {
  const users = (await db.getAll('users'))
    .filter((u) => includeDisabled || !u.disabled)
    .sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1));
  for (const u of users) {
    if (!u.wrap) continue; // PIN'siz hesap
    try {
      const dek = await unwrapDek(u.wrap, pin, u.role === 'admin');
      return { user: u, dek };
    } catch { /* bu kullanıcının PIN'i değil */ }
  }
  return null;
}

/**
 * İlk kurulum: yönetici hesabı ve veri anahtarı oluşturur.
 * PIN verilmezse hesap PIN'siz açılır ve uygulama bu cihazda otomatik giriş yapar.
 */
export async function setupAdmin(pin = null) {
  if (await isSetupDone()) throw new Error('Kurulum zaten yapılmış.');
  if (pin != null) validatePin(pin);
  const dek = await generateDek();
  const wrap = pin != null ? await wrapDek(dek, pin) : null;
  const user = {
    id: crypto.randomUUID(), username: 'Yönetici', role: 'admin', wrap,
    createdAt: Date.now(), disabled: false,
  };
  await db.put('users', user);
  await setMeta('setup', { createdAt: Date.now(), version: 3, auth: pin != null ? 'pin' : 'device' });
  session.user = publicUser(user);
  session.dek = dek; // yönetici anahtarı yeni kullanıcılara sarılabilmek için dışa aktarılabilir tutulur
  touch();
  if (pin == null) await enableAutoLogin();
  return session.user;
}

/* ------------------------------------------------- CİHAZDA OTOMATİK GİRİŞ */

/**
 * Otomatik giriş: veri anahtarı (DEK), bu cihazın tarayıcı deposunda tutulan ve DIŞA AKTARILAMAYAN
 * bir cihaz anahtarıyla sarılır. Veriler diskte yine şifreli durur; ancak uygulamayı bu telefonda açan
 * herkes kayıtlara erişir. Koruma telefonun kendi ekran kilidine kalır.
 */
async function deviceKey(create) {
  let k = await getMeta('deviceKey');
  if (!k && create) {
    k = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
    await setMeta('deviceKey', k);
  }
  return k;
}

export async function isAutoLoginEnabled() {
  return !!(await getMeta('autoLogin'));
}

export async function enableAutoLogin() {
  if (!session.user || session.user.role !== 'admin') throw new Error('Otomatik giriş yalnızca yönetici için açılabilir.');
  const k = await deviceKey(true);
  const wrapped = await crypto.subtle.wrapKey('raw', session.dek, k, 'AES-KW');
  await setMeta('autoLogin', { userId: session.user.id, wrapped: toB64(wrapped), at: Date.now() });
}

export async function disableAutoLogin() {
  const u = await db.get('users', session.user?.id);
  if (!u?.wrap) throw new Error('Önce bir PIN belirleyin; aksi halde uygulamaya giriş yapılamaz.');
  await db.delete('meta', 'autoLogin');
}

/** Cihazda otomatik giriş açıksa PIN sormadan oturum açar; değilse null döner. */
export async function tryAutoLogin() {
  const a = await getMeta('autoLogin');
  const k = a && await deviceKey(false);
  if (!a || !k) return null;
  const u = await db.get('users', a.userId);
  if (!u || u.disabled) return null;
  try {
    session.dek = await crypto.subtle.unwrapKey('raw', fromB64(a.wrapped), k, 'AES-KW',
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  } catch {
    return null;
  }
  session.user = publicUser(u);
  touch();
  return session.user;
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, disabled: u.disabled };
}

/** PIN ile giriş. Ardışık hatalı denemelerde artan bekleme uygulanır. */
export async function login(pin) {
  const failKey = 'loginFail:pin';
  const fail = (await getMeta(failKey)) || { count: 0, until: 0 };
  if (Date.now() < fail.until) {
    const s = Math.ceil((fail.until - Date.now()) / 1000);
    throw new Error(`Çok sayıda hatalı deneme. ${s} saniye sonra tekrar deneyin.`);
  }
  const found = pin ? await userForPin(String(pin)) : null;
  if (!found) {
    const count = fail.count + 1;
    const delay = count >= 3 ? Math.min(15 * 60_000, 2 ** (count - 3) * 15_000) : 0;
    await setMeta(failKey, { count, until: Date.now() + delay });
    throw new Error(count >= 3 ? `PIN hatalı. ${Math.round(delay / 1000)} saniye bekleyin.` : 'PIN hatalı.');
  }
  await setMeta(failKey, { count: 0, until: 0 });
  session.user = publicUser(found.user);
  session.dek = found.dek;
  touch();
  return session.user;
}

/** Oturumdaki kullanıcının PIN'ini doğrular (yönetim ekranları için yeniden onay). */
export async function verifyOwnPin(pin) {
  const u = await db.get('users', session.user.id);
  if (!u.wrap) return true; // PIN'siz hesap
  try {
    session.dek = await unwrapDek(u.wrap, pin, u.role === 'admin');
    touch();
    return true;
  } catch {
    return false;
  }
}

/** Geri yükleme sonrası: yedekteki yöneticiyle oturumu doğrudan açar */
export function adoptSession(user, dek) {
  session.user = publicUser(user);
  session.dek = dek;
  touch();
}

export function logout() {
  session.user = null;
  session.dek = null;
}

/** Tüm verileri siler (PIN unutulduğunda yeniden kurulum için). */
export async function factoryReset() {
  for (const store of ['users', 'personnel', 'vehicles', 'events', 'audit', 'meta']) await db.clear(store);
  logout();
}

export async function listUsers() {
  requirePermission('users');
  return (await db.getAll('users')).map(publicUser);
}

export async function addUser(username, pin, role) {
  requirePermission('users');
  validateUsername(username);
  validatePin(pin);
  if (!ROLES[role]) throw new Error('Geçersiz rol');
  if (await findUser(username.trim())) throw new Error('Bu kullanıcı adı zaten var.');
  if (await userForPin(pin, { includeDisabled: true })) throw new Error('Bu PIN başka bir kullanıcıda kullanılıyor. Farklı bir PIN seçin.');
  const wrap = await wrapDek(session.dek, pin);
  const user = { id: crypto.randomUUID(), username: username.trim(), role, wrap, createdAt: Date.now(), disabled: false };
  await db.put('users', user);
  return publicUser(user);
}

export async function setUserDisabled(id, disabled) {
  requirePermission('users');
  const u = await db.get('users', id);
  if (!u) throw new Error('Kullanıcı bulunamadı');
  if (u.id === session.user.id) throw new Error('Kendi hesabınızı devre dışı bırakamazsınız.');
  if (u.role === 'admin' && disabled) {
    const admins = (await db.getAll('users')).filter((x) => x.role === 'admin' && !x.disabled);
    if (admins.length <= 1) throw new Error('En az bir etkin yönetici kalmalıdır.');
  }
  u.disabled = disabled;
  await db.put('users', u);
}

export async function deleteUser(id) {
  requirePermission('users');
  const u = await db.get('users', id);
  if (!u) return;
  if (u.id === session.user.id) throw new Error('Kendi hesabınızı silemezsiniz.');
  if (u.role === 'admin') {
    const admins = (await db.getAll('users')).filter((x) => x.role === 'admin' && !x.disabled);
    if (admins.length <= 1) throw new Error('Son yönetici silinemez.');
  }
  await db.delete('users', id);
}

export async function changeOwnPassword(oldPw, newPw) {
  validatePin(newPw);
  const other = await userForPin(newPw, { includeDisabled: true });
  if (other && other.user.id !== session.user.id) throw new Error('Bu PIN başka bir kullanıcıda kullanılıyor.');
  const u = await db.get('users', session.user.id);
  // PIN'siz hesapta ilk PIN belirlenirken eski PIN sorulmaz
  const dek = u.wrap ? await unwrapDek(u.wrap, oldPw, true).catch(() => null) : session.dek;
  if (!dek) throw new Error('Mevcut PIN hatalı.');
  u.wrap = await wrapDek(dek, newPw);
  await db.put('users', u);
}

/** Yönetici başka bir kullanıcının parolasını sıfırlar (DEK yönetici oturumundan yeniden sarılır). */
export async function resetUserPassword(id, newPw) {
  requirePermission('users');
  validatePin(newPw);
  const u = await db.get('users', id);
  if (!u) throw new Error('Kullanıcı bulunamadı');
  const other = await userForPin(newPw, { includeDisabled: true });
  if (other && other.user.id !== id) throw new Error('Bu PIN başka bir kullanıcıda kullanılıyor.');
  u.wrap = await wrapDek(session.dek, newPw);
  await db.put('users', u);
}
