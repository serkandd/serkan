/**
 * Uçtan uca yerel şifreleme (Web Crypto API).
 *
 * Anahtar hiyerarşisi:
 *   - DEK (Data Encryption Key): rastgele AES-GCM 256 bit; tüm kayıtları şifreler.
 *   - KEK (Key Encryption Key): kullanıcı parolasından PBKDF2-SHA256 (310.000 tur) ile türetilir.
 *   - Her kullanıcı kaydında DEK, o kullanıcının KEK'i ile sarılmış (wrapped) olarak tutulur.
 *     Parola bilinmeden DEK, dolayısıyla veriler çözülemez.
 *
 * DEK yalnızca oturum açıkken bellekte (extractable=false CryptoKey olarak) tutulur.
 */

const subtle = globalThis.crypto.subtle;
export const PBKDF2_ITERATIONS = 310_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function deriveKek(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Yeni rastgele veri anahtarı (sarılabilmesi için extractable=true üretilir, sonra yeniden içe alınır) */
export async function generateDek() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapDek(dek, password) {
  const salt = randomBytes(16);
  const kek = await deriveKek(password, salt);
  const wrapped = await subtle.wrapKey('raw', dek, kek, 'AES-KW');
  return { salt: toB64(salt), wrapped: toB64(wrapped), iterations: PBKDF2_ITERATIONS };
}

/** Parola yanlışsa hata fırlatır. extractable: yeni kullanıcıya sarmak için yönetici oturumunda gerekir. */
export async function unwrapDek(wrapInfo, password, extractable = false) {
  const kek = await deriveKek(password, fromB64(wrapInfo.salt), wrapInfo.iterations);
  return subtle.unwrapKey(
    'raw', fromB64(wrapInfo.wrapped), kek, 'AES-KW',
    { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(dek, obj) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, dek, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson(dek, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, dek, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

export async function encryptBytes(dek, bytes) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes);
  return { iv: toB64(iv), ct: new Uint8Array(ct) };
}

export async function decryptBytes(dek, box) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, dek, box.ct));
}

export async function sha256Hex(text) {
  const h = await subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
