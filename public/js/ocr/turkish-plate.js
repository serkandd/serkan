/**
 * Türk plaka formatı doğrulama ve OCR karakter düzeltme.
 *
 * Türk plaka yapısı:  [İL KODU 01-81] [HARF GRUBU] [RAKAM GRUBU]
 *   1 harf  → 4 veya 5 rakam   (örn. 34 A 1234, 06 B 12345)
 *   2 harf  → 3 veya 4 rakam   (örn. 34 AB 123, 34 AB 1234)
 *   3 harf  → 2 veya 3 rakam   (örn. 34 ABC 12, 34 ABC 123)
 *
 * Plakalarda Türkçe'ye özgü Ç, Ğ, İ, Ö, Ş, Ü ile Q, W, X harfleri kullanılmaz.
 *
 * Bu modül saf (DOM'suz) JavaScript'tir; hem tarayıcıda hem Node testlerinde çalışır.
 */

export const PLATE_LETTERS = 'ABCDEFGHIJKLMNOPRSTUVYZ';
export const PLATE_DIGITS = '0123456789';
export const OCR_WHITELIST = PLATE_LETTERS + PLATE_DIGITS;

/** Harf/rakam grubu uzunluk kuralları: harf sayısı → izinli rakam sayıları */
const GROUP_RULES = { 1: [4, 5], 2: [3, 4], 3: [2, 3] };

/** Rakam beklenen konumda harf okunduysa uygulanacak dönüşüm (görsel benzerlik) */
const LETTER_TO_DIGIT = {
  O: '0', D: '0', Q: '0', U: '0',
  I: '1', L: '1', J: '1', T: '7',
  Z: '2', S: '5', B: '8', G: '6', A: '4', E: '8', Y: '7', P: '9',
};

/** Harf beklenen konumda rakam okunduysa uygulanacak dönüşüm */
const DIGIT_TO_LETTER = {
  0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B',
};

/** Plakada kullanılmayan ama OCR'ın üretebileceği harflerin en olası karşılığı */
const FOREIGN_LETTER_MAP = { Q: 'O', W: 'V', X: 'K' };

/** İl kodları (01-81) */
export function isValidProvince(code) {
  if (!/^\d{2}$/.test(code)) return false;
  const n = Number(code);
  return n >= 1 && n <= 81;
}

/**
 * Ham OCR çıktısını temizler: Türkçe karakterleri dönüştürür, ayraçları atar,
 * soldaki "TR" ülke kodunu (mavi bant) temizler.
 */
export function sanitizeRaw(raw) {
  if (!raw) return '';
  let s = String(raw)
    .toLocaleUpperCase('en-US')
    .replace(/İ/g, 'I').replace(/I/g, 'I')
    .replace(/Ç/g, 'C').replace(/Ğ/g, 'G').replace(/Ö/g, 'O')
    .replace(/Ş/g, 'S').replace(/Ü/g, 'U')
    .replace(/[^A-Z0-9]/g, '');
  // Soldaki mavi banttaki "TR" yazısı OCR'a girmişse ve ardından il kodu geliyorsa sil
  if (/^TR\d{2}/.test(s)) s = s.slice(2);
  return s;
}

/** Temel kanonik biçim doğrulaması (düzeltme yapmadan). */
export function isValidTurkishPlate(text) {
  const s = sanitizeRaw(text);
  const m = /^(\d{2})([A-Z]{1,3})(\d{2,5})$/.exec(s);
  if (!m) return false;
  const [, prov, letters, digits] = m;
  if (!isValidProvince(prov)) return false;
  for (const ch of letters) if (!PLATE_LETTERS.includes(ch)) return false;
  const allowed = GROUP_RULES[letters.length];
  if (!allowed || !allowed.includes(digits.length)) return false;
  // Rakam grubu tamamen sıfır olamaz
  if (/^0+$/.test(digits)) return false;
  return true;
}

/** "34ABC123" → "34 ABC 123" */
export function formatPlate(text) {
  const s = sanitizeRaw(text);
  const m = /^(\d{2})([A-Z]{1,3})(\d{2,5})$/.exec(s);
  if (!m) return s;
  return `${m[1]} ${m[2]} ${m[3]}`;
}

function coerceDigit(ch) {
  if (PLATE_DIGITS.includes(ch)) return { ch, cost: 0 };
  const d = LETTER_TO_DIGIT[ch];
  return d ? { ch: d, cost: 1 } : null;
}

function coerceLetter(ch) {
  if (PLATE_LETTERS.includes(ch)) return { ch, cost: 0 };
  if (FOREIGN_LETTER_MAP[ch]) return { ch: FOREIGN_LETTER_MAP[ch], cost: 1 };
  const l = DIGIT_TO_LETTER[ch];
  return l ? { ch: l, cost: 1 } : null;
}

/**
 * Konum farkındalıklı düzeltme. Ham diziden olası tüm geçerli plaka
 * segmentasyonlarını üretir ve en az düzeltme gerektireni seçer.
 *
 * @param {string} raw OCR çıktısı
 * @param {object} [opts]
 * @param {number} [opts.maxCorrections=2] Kabul edilecek en fazla karakter düzeltmesi
 * @returns {{plate:string, formatted:string, corrections:number, raw:string}|null}
 *   Geçerli bir plaka üretilemiyorsa null döner (yanlış tahmin YAPILMAZ).
 */
export function correctPlate(raw, opts = {}) {
  const maxCorrections = opts.maxCorrections ?? 2;
  const s = sanitizeRaw(raw);
  if (s.length < 5) return null;

  const candidates = [];
  // OCR bazen kenar gürültüsünden baş/sona fazladan bir karakter ekler; 0-1 kırpma dene
  const trims = [];
  for (let a = 0; a <= 1; a++) {
    for (let b = 0; b <= 1; b++) {
      if (s.length - a - b >= 5) trims.push({ str: s.slice(a, s.length - b), trimCost: a + b });
    }
  }

  for (const { str, trimCost } of trims) {
    for (const nL of [1, 2, 3]) {
      for (const nD of GROUP_RULES[nL]) {
        if (2 + nL + nD !== str.length) continue;
        let cost = trimCost;
        let out = '';
        let ok = true;
        for (let i = 0; i < str.length && ok; i++) {
          const isLetterPos = i >= 2 && i < 2 + nL;
          const r = isLetterPos ? coerceLetter(str[i]) : coerceDigit(str[i]);
          if (!r) ok = false;
          else { out += r.ch; cost += r.cost; }
        }
        if (!ok || cost > maxCorrections) continue;
        if (!isValidTurkishPlate(out)) continue;
        candidates.push({ plate: out, corrections: cost, nL, nD });
      }
    }
  }
  if (!candidates.length) return null;

  // Düşük maliyet öncelikli; eşitlikte daha yaygın formatları (2-3 harf) tercih et
  const commonness = { 1: 2, 2: 0, 3: 1 };
  candidates.sort((a, b) => a.corrections - b.corrections || commonness[a.nL] - commonness[b.nL]);
  const best = candidates[0];

  // Eşit maliyetli farklı adaylar varsa belirsizdir → kesin sonuç verme
  const ambiguous = candidates.filter((c) => c.corrections === best.corrections && c.plate !== best.plate);
  if (ambiguous.length && best.corrections > 0) return null;

  return { plate: best.plate, formatted: formatPlate(best.plate), corrections: best.corrections, raw: s };
}

/** Kayıt veritabanında aramak için anahtar (boşluksuz, büyük harf). */
export function plateKey(text) {
  return sanitizeRaw(text);
}

/**
 * Derin öğrenme OCR'ının karakter olasılıklarından Türk plaka formatına uyan EN OLASI plakayı bulur.
 *
 * Model her karakter yuvası için tüm sınıfların olasılığını verir. Burada her geçerli Türk plaka
 * kalıbı (il kodu 01-81 + 1-3 harf + 2-5 rakam) için toplam log-olasılık hesaplanır ve en yükseği
 * seçilir. Böylece "0/O", "8/B", "1/I" gibi karışıklıklar konuma göre doğru çözülür; formata uymayan
 * okumalar zorla eşleştirilmez (güven düşük çıkar).
 *
 * @param {Float32Array|number[]} probs  [slots × alphabet.length] olasılıklar (softmax sonrası)
 * @param {object} cfg {slots, alphabet, padChar}
 * @returns {{plate:string, confidence:number, charConf:number[], raw:string, rawConf:number}|null}
 */
export function decodeTurkishPlate(probs, { slots = 10, alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_', padChar = '_' } = {}) {
  const A = alphabet.length;
  const eps = 1e-6;
  const lp = (slot, ch) => Math.log(Math.max(eps, probs[slot * A + alphabet.indexOf(ch)]));
  const digitIdx = [...PLATE_DIGITS].map((c) => alphabet.indexOf(c));
  const letterIdx = [...PLATE_LETTERS].map((c) => alphabet.indexOf(c));
  const padIdx = alphabet.indexOf(padChar);

  // Ham (kısıtsız) okuma: karşılaştırma ve tanılama için
  let raw = '', rawLog = 0;
  for (let s = 0; s < slots; s++) {
    let best = 0;
    for (let k = 1; k < A; k++) if (probs[s * A + k] > probs[s * A + best]) best = k;
    rawLog += Math.log(Math.max(eps, probs[s * A + best]));
    raw += alphabet[best];
  }
  raw = raw.replace(new RegExp(`${padChar}+$`), '').replaceAll(padChar, '');

  const bestOf = (slot, idxs) => {
    let bi = idxs[0], bv = -Infinity;
    for (const i of idxs) {
      const v = Math.log(Math.max(eps, probs[slot * A + i]));
      if (v > bv) { bv = v; bi = i; }
    }
    return { ch: alphabet[bi], lp: bv };
  };
  // Sondaki boş yuvaların log-olasılığı (önceden toplanmış)
  const padTail = new Float64Array(slots + 1);
  for (let s = slots - 1; s >= 0; s--) padTail[s] = padTail[s + 1] + Math.log(Math.max(eps, probs[s * A + padIdx]));

  // İl kodu: 01-81 arası en olası iki rakam
  let prov = null;
  for (let n = 1; n <= 81; n++) {
    const code = String(n).padStart(2, '0');
    const v = lp(0, code[0]) + lp(1, code[1]);
    if (!prov || v > prov.lp) prov = { code, lp: v };
  }

  let best = null;
  for (const [nL, ds] of Object.entries(GROUP_RULES)) {
    for (const nD of ds) {
      const len = 2 + Number(nL) + nD;
      if (len > slots) continue;
      let total = prov.lp;
      let text = prov.code;
      const chars = [];
      for (let s = 2; s < len; s++) {
        const r = bestOf(s, s < 2 + Number(nL) ? letterIdx : digitIdx);
        total += r.lp;
        text += r.ch;
        chars.push(r.lp);
      }
      total += padTail[len];
      if (!best || total > best.total) best = { text, total, len };
    }
  }
  if (!best) return null;
  const charConf = [];
  for (let s = 0; s < best.len; s++) charConf.push(probs[s * A + alphabet.indexOf(best.text[s])]);
  // Güven: tüm yuvaların birleşik olasılığı (geometrik ortalama değil, çarpım) — tek şüpheli karakter güveni düşürür
  return {
    plate: best.text,
    confidence: Math.exp(best.total),
    charConf,
    raw,
    rawConf: Math.exp(rawLog),
    valid: isValidTurkishPlate(best.text),
  };
}
