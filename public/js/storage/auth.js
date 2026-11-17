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
import { generateDek, wrapDek, unwrapDek } from './crypto.js';

export const ROLES = {
  admin: { label: 'Yönetici', can: ['live', 'events', 'personnel', 'vehicles', 'users', 'settings', 'audit', 'export'] },
  operator: { label: 'Güvenlik Görevlisi', can: ['live', 'events'] },
};

export const MIN_PASSWORD = 8;

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

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw new Error(`Parola en az ${MIN_PASSWORD} karakter olmalıdır.`);
  }
  if (!/[0-9]/.test(pw) || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(pw)) {
    throw new Error('Parola en az bir harf ve bir rakam içermelidir.');
  }
}

function validateUsername(u) {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u || '')) {
    throw new Error('Kullanıcı adı 3-32 karakter olmalı; harf, rakam, nokta, tire içerebilir.');
  }
}

async function findUser(username) {
  const all = await db.getAll('users');
  return all.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

/** İlk kurulum: yönetici hesabı ve veri anahtarı oluşturur. */
export async function setupAdmin(username, password) {
  if (await isSetupDone()) throw new Error('Kurulum zaten yapılmış.');
  validateUsername(username);
  validatePassword(password);
  const dek = await generateDek();
  const wrap = await wrapDek(dek, password);
  const user = {
    id: crypto.randomUUID(), username, role: 'admin', wrap,
    createdAt: Date.now(), disabled: false,
  };
  await db.put('users', user);
  await setMeta('setup', { createdAt: Date.now(), version: 1 });
  const usable = await unwrapDek(wrap, password, true);
  session.user = publicUser(user);
  session.dek = usable;
  touch();
  return session.user;
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, disabled: u.disabled };
}

export async function login(username, password) {
  const failKey = `loginFail:${(username || '').toLowerCase()}`;
  const fail = (await getMeta(failKey)) || { count: 0, until: 0 };
  if (Date.now() < fail.until) {
    const s = Math.ceil((fail.until - Date.now()) / 1000);
    throw new Error(`Çok sayıda hatalı deneme. ${s} saniye sonra tekrar deneyin.`);
  }
  const user = await findUser(username || '');
  let dek = null;
  if (user && !user.disabled) {
    try {
      dek = await unwrapDek(user.wrap, password, user.role === 'admin');
    } catch {
      dek = null;
    }
  }
  if (!dek) {
    const count = fail.count + 1;
    const delay = count >= 3 ? Math.min(15 * 60_000, 2 ** (count - 3) * 15_000) : 0;
    await setMeta(failKey, { count, until: Date.now() + delay });
    throw new Error(user?.disabled ? 'Hesap devre dışı.' : 'Kullanıcı adı veya parola hatalı.');
  }
  await setMeta(failKey, { count: 0, until: 0 });
  session.user = publicUser(user);
  session.dek = dek;
  touch();
  return session.user;
}

export function logout() {
  session.user = null;
  session.dek = null;
}

export async function listUsers() {
  requirePermission('users');
  return (await db.getAll('users')).map(publicUser);
}

export async function addUser(username, password, role) {
  requirePermission('users');
  validateUsername(username);
  validatePassword(password);
  if (!ROLES[role]) throw new Error('Geçersiz rol');
  if (await findUser(username)) throw new Error('Bu kullanıcı adı zaten var.');
  const wrap = await wrapDek(session.dek, password);
  const user = { id: crypto.randomUUID(), username, role, wrap, createdAt: Date.now(), disabled: false };
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
  validatePassword(newPw);
  const u = await db.get('users', session.user.id);
  const dek = await unwrapDek(u.wrap, oldPw, true).catch(() => null);
  if (!dek) throw new Error('Mevcut parola hatalı.');
  u.wrap = await wrapDek(dek, newPw);
  await db.put('users', u);
}

/** Yönetici başka bir kullanıcının parolasını sıfırlar (DEK yönetici oturumundan yeniden sarılır). */
export async function resetUserPassword(id, newPw) {
  requirePermission('users');
  validatePassword(newPw);
  const u = await db.get('users', id);
  if (!u) throw new Error('Kullanıcı bulunamadı');
  u.wrap = await wrapDek(session.dek, newPw);
  await db.put('users', u);
}
