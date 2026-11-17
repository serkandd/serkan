import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidTurkishPlate, correctPlate, formatPlate, sanitizeRaw, isValidProvince } from '../../public/js/ocr/turkish-plate.js';

test('geçerli Türk plaka formatları', () => {
  for (const p of ['34 A 1234', '06 B 12345', '34 AB 123', '34 AB 1234', '35 ABC 12', '81 ZZZ 999', '01AB123']) {
    assert.ok(isValidTurkishPlate(p), p);
  }
});

test('geçersiz formatlar reddedilir', () => {
  for (const p of ['00 A 1234', '82 AB 123', '34 ABCD 12', '34 A 123', '34 AB 12345', '34 ABC 1234', '34 QA 123', 'ABC', '34 AB 000', '']) {
    assert.equal(isValidTurkishPlate(p), false, p);
  }
});

test('il kodu aralığı', () => {
  assert.ok(isValidProvince('01'));
  assert.ok(isValidProvince('81'));
  assert.equal(isValidProvince('00'), false);
  assert.equal(isValidProvince('82'), false);
});

test('TR bandı ve ayraçlar temizlenir', () => {
  assert.equal(sanitizeRaw('TR 34-ABC.123\n'), '34ABC123');
  assert.equal(sanitizeRaw('34 abc 123'), '34ABC123');
});

test('konuma göre OCR karakter düzeltme', () => {
  assert.equal(correctPlate('34ABC123').plate, '34ABC123');
  assert.equal(correctPlate('34ABC123').corrections, 0);
  // il kodunda O→0, harf grubunda 8→B, rakam grubunda S→5
  assert.equal(correctPlate('O6A8C12S'), null); // 3 düzeltme > varsayılan sınır (2)
  assert.equal(correctPlate('O6ABC125').plate, '06ABC125');
  const r = correctPlate('3S AB 1Z3');
  assert.equal(r.plate, '35AB123');
  assert.equal(r.corrections, 2);
  assert.equal(correctPlate('06 8C 123').plate, '06BC123');
});

test('çok fazla düzeltme gerekiyorsa tahmin yapılmaz', () => {
  assert.equal(correctPlate('OOOOOOOO'), null);
  assert.equal(correctPlate('HELLO WORLD'), null);
  assert.equal(correctPlate('12'), null);
  assert.equal(correctPlate('SSABCSSS', { maxCorrections: 2 }), null);
});

test('kenardaki gürültü karakteri kırpılır', () => {
  const r = correctPlate('I34ABC123');
  assert.equal(r.plate, '34ABC123');
});

test('biçimlendirme', () => {
  assert.equal(formatPlate('34abc123'), '34 ABC 123');
  assert.equal(formatPlate('06A12345'), '06 A 12345');
});
