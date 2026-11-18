import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTurkishPlate } from '../../public/js/ocr/turkish-plate.js';

const AL = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
/** Basit olasılık matrisi: her yuvaya [karakter → olasılık] eşlemesi */
function mat(slots) {
  const p = new Float32Array(10 * AL.length);
  for (let s = 0; s < 10; s++) {
    const m = slots[s] || { _: 1 };
    let rest = 1;
    for (const [c, v] of Object.entries(m)) { p[s * AL.length + AL.indexOf(c)] = v; rest -= v; }
    const others = AL.length - Object.keys(m).length;
    for (let k = 0; k < AL.length; k++) if (!(AL[k] in m)) p[s * AL.length + k] = Math.max(0, rest) / others;
  }
  return p;
}

test('net okuma aynen döner, güven yüksek', () => {
  const r = decodeTurkishPlate(mat([{ 3: 0.99 }, { 4: 0.99 }, { A: 0.98 }, { B: 0.97 }, { C: 0.99 }, { 1: 0.99 }, { 2: 0.99 }, { 3: 0.98 }]));
  assert.equal(r.plate, '34ABC123');
  assert.ok(r.confidence > 0.85, String(r.confidence));
});

test('konuma göre karışıklık çözülür: harf yerinde 8 → B, rakam yerinde O → 0', () => {
  const r = decodeTurkishPlate(mat([{ 0: 0.5, O: 0.45 }, { 6: 0.9 }, { 8: 0.55, B: 0.4 }, { C: 0.95 }, { 1: 0.9 }, { O: 0.6, 0: 0.35 }, { 5: 0.9 }]));
  assert.equal(r.plate, '06BC105');
});

test('il kodu 01-81 dışına çıkamaz', () => {
  const r = decodeTurkishPlate(mat([{ 9: 0.8, 3: 0.15 }, { 9: 0.7, 4: 0.25 }, { A: 0.9 }, { 1: 0.9 }, { 2: 0.9 }, { 3: 0.9 }, { 4: 0.9 }]));
  assert.ok(Number(r.plate.slice(0, 2)) <= 81 && Number(r.plate.slice(0, 2)) >= 1, r.plate);
});

test('formata uymayan okuma düşük güven alır', () => {
  // "ABCDEFG": harf olması gereken yerde de rakam olması gereken yerde de harfler var
  const r = decodeTurkishPlate(mat([{ A: 0.95 }, { B: 0.95 }, { C: 0.95 }, { D: 0.95 }, { E: 0.95 }, { F: 0.95 }, { G: 0.95 }]));
  assert.ok(r.confidence < 0.01, String(r.confidence));
  assert.equal(r.raw, 'ABCDEFG');
});
