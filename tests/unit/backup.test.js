import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../../public/js/storage/auth.js';
import * as repo from '../../public/js/storage/repos.js';
import * as backup from '../../public/js/storage/backup.js';
import { db } from '../../public/js/storage/db.js';

test("yedek → uygulama silinip yeniden kuruldu → geri yükleme: veriler ve PIN'siz giriş geri gelir", async () => {
  await auth.setupAdmin(null);
  await repo.saveVehicle({ plate: '34 ABC 123', owner: 'Serkan Bilge', company: 'Sade Ekonomi', status: 'authorized' });
  await repo.savePersonnel({ employeeNo: 'K-1', fullName: 'Serkan Bilge', status: 'authorized',
    descriptors: [Array.from({ length: 512 }, (_, i) => Math.sin(i))], consent: { informed: true, legalBasis: 'açık rıza' } });
  const text = await backup.buildBackup();
  assert.ok(!text.includes('Serkan'), 'yedek dosyasında açık metin yok');

  // Uygulama silindi: tüm veriler ve cihaz anahtarı gitti, yeni kurulum yapıldı
  await auth.factoryReset();
  await auth.setupAdmin(null);
  await repo.loadVehicles();
  assert.equal(repo.vehicles().length, 0);

  const r = await backup.restoreBackup({ text: async () => text });
  assert.equal(r.autoLogin, true);
  assert.equal(r.vehicles, 1);
  auth.logout(); // uygulama yeniden açılıyor
  assert.ok(await auth.tryAutoLogin(), 'PIN sorulmadan açılır');
  await repo.loadVehicles();
  await repo.loadPersonnel();
  assert.equal(repo.findVehicleByPlate('34ABC123').company, 'Sade Ekonomi');
  assert.equal(repo.personnel()[0].descriptors[0].length, 512);
  assert.equal((await db.getAll('users')).length, 1);
});

test('geçersiz dosya mevcut verilere dokunmaz', async () => {
  const before = (await db.getAll('vehicles')).length;
  await assert.rejects(backup.restoreBackup({ text: async () => 'bozuk' }), /okunamadı/);
  await assert.rejects(backup.restoreBackup({ text: async () => '{"format":"x"}' }), /yedeği değil/);
  assert.equal((await db.getAll('vehicles')).length, before);
});
