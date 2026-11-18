import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../../public/js/storage/auth.js';
import * as repo from '../../public/js/storage/repos.js';
import { db } from '../../public/js/storage/db.js';

test('PIN\'siz kurulum: uygulama yeniden açıldığında otomatik giriş, veriler şifreli', async () => {
  await auth.setupAdmin(null);
  assert.equal(await auth.isAutoLoginEnabled(), true);
  await repo.saveVehicle({ plate: '34 ABC 123', owner: 'Serkan Bilge', status: 'authorized' });
  assert.ok(!JSON.stringify(await db.getAll('vehicles')).includes('Serkan'), 'diskte açık metin yok');

  auth.logout(); // uygulama kapandı
  const u = await auth.tryAutoLogin();
  assert.equal(u.role, 'admin');
  await repo.loadVehicles();
  assert.equal(repo.findVehicleByPlate('34ABC123').owner, 'Serkan Bilge');

  // PIN belirlenmeden PIN sorma açılamaz; belirlenince açılır ve otomatik giriş kapanır
  await assert.rejects(auth.disableAutoLogin(), /PIN belirleyin/);
  await auth.changeOwnPassword('', '4321');
  await auth.disableAutoLogin();
  auth.logout();
  assert.equal(await auth.tryAutoLogin(), null);
  await auth.login('4321');
  await repo.loadVehicles();
  assert.equal(repo.findVehicleByPlate('34ABC123').owner, 'Serkan Bilge');
});
