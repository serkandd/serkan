import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../../public/js/storage/auth.js';
import * as repo from '../../public/js/storage/repos.js';
import { encryptJson, decryptJson, generateDek, wrapDek, unwrapDek } from '../../public/js/storage/crypto.js';
import { db } from '../../public/js/storage/db.js';

test('şifreleme gidiş-dönüş ve yanlış parola', async () => {
  const dek = await generateDek();
  const box = await encryptJson(dek, { a: 1, s: 'gizli' });
  assert.ok(!box.ct.includes('gizli'));
  assert.deepEqual(await decryptJson(dek, box), { a: 1, s: 'gizli' });
  const w = await wrapDek(dek, 'Parola123');
  const d2 = await unwrapDek(w, 'Parola123');
  assert.deepEqual(await decryptJson(d2, box), { a: 1, s: 'gizli' });
  await assert.rejects(unwrapDek(w, 'yanlis999'));
});

test('kurulum, roller, kayıtlar, olaylar, işlem kaydı zinciri', async () => {
  await assert.rejects(auth.setupAdmin('yonetici', 'kisa'), /en az/);
  await auth.setupAdmin('yonetici', 'GucluParola1');
  assert.ok(auth.can('personnel'));

  // Araç kaydı + format doğrulaması
  await assert.rejects(repo.saveVehicle({ plate: '99 XX 1', status: 'authorized' }), /format/);
  await repo.saveVehicle({ plate: '34abc123', owner: 'Ali Veli', company: 'ACME', status: 'authorized' });
  await repo.saveVehicle({ plate: '06 KY 4321', status: 'unauthorized' });
  await assert.rejects(repo.saveVehicle({ plate: '34 ABC 123', status: 'authorized' }), /zaten/);
  assert.equal(repo.findVehicleByPlate('34 ABC 123').owner, 'Ali Veli');
  assert.equal(repo.findVehicleByPlate('34ABC124'), null);

  // Biyometrik şablon hukuki onay olmadan kaydedilemez
  const desc = Array.from({ length: 128 }, (_, i) => i / 1000);
  await assert.rejects(repo.savePersonnel({ employeeNo: '1', fullName: 'Ayşe', status: 'authorized', descriptors: [desc] }), /aydınlatma/);
  await repo.savePersonnel({ employeeNo: '1', fullName: 'Ayşe Yılmaz', status: 'authorized', descriptors: [desc], consent: { informed: true, legalBasis: 'Açık rıza 2026/1' } });
  assert.equal(repo.personnel().length, 1);

  // Veritabanında açık metin yok
  const raw = JSON.stringify(await db.getAll('personnel')) + JSON.stringify(await db.getAll('vehicles'));
  assert.ok(!raw.includes('Ayşe') && !raw.includes('34ABC123') && !raw.includes('Ali Veli'));

  // Görevli kullanıcı: kayıt yönetemez
  await auth.addUser('gorevli1', 'Gorevli2026', 'operator');
  auth.logout();
  await assert.rejects(auth.login('gorevli1', 'yanlis1234'), /hatalı/);
  await auth.login('gorevli1', 'Gorevli2026');
  assert.equal(auth.can('personnel'), false);
  await assert.rejects(repo.saveVehicle({ plate: '35 AB 123', status: 'authorized' }), /yetkiniz/);
  await repo.loadVehicles();
  assert.ok(repo.findVehicleByPlate('34ABC123'), 'görevli araç listesini okuyabilmeli (karşılaştırma için)');

  // Olay + insan onayı
  const ev = await repo.addEvent({ kind: 'plate', result: 'authorized', plate: '34ABC123' });
  await repo.reviewEvent(ev.id, 'confirmed');
  const list = await repo.listEvents(10);
  assert.equal(list[0].review.decision, 'confirmed');
  assert.equal(list[0].review.by, 'gorevli1');

  // İşlem kaydı zinciri ve kurcalama tespiti
  await repo.audit('test.a', 'x', {});
  await repo.audit('test.b', 'x', {});
  assert.equal((await repo.verifyAuditChain()).ok, true);
  const rows = await db.getAll('audit');
  rows[0].enc.ct = rows[0].enc.ct.slice(0, -4) + 'AAAA';
  await db.put('audit', rows[0]);
  assert.equal((await repo.verifyAuditChain()).ok, false);
});
