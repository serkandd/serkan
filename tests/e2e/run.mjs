#!/usr/bin/env node
/**
 * Uçtan uca test (headless Chromium + gerçek modeller).
 *
 * Gerçek kamera yerine, getUserMedia'yı bir <canvas> akışıyla değiştirir. Akışta:
 *   - 4 kişilik gerçek bir fotoğraf (yüz algılama + 1 kayıtlı / 3 kayıtsız kişi)
 *   - Hareket eden, Türk standardında çizilmiş bir plaka ("34 ABC 123", mavi TR bandı)
 * bulunur. Uygulama kurulur, araç ve personel kaydı yapılır, kamera başlatılır ve
 * analiz sonuçları doğrulanır. Ekran görüntüleri test-results/ altına kaydedilir.
 *
 * Kullanım: npm run e2e   (Playwright ve Chromium kurulu olmalı)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'test-results');
mkdirSync(out, { recursive: true });

let playwright;
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch {
  playwright = createRequire(join(execSync('npm root -g').toString().trim(), 'x'))('playwright');
}

const PORT = 8765;
const server = spawn(process.execPath, [join(root, 'scripts/serve.mjs')], { env: { ...process.env, HTTP: '1', PORT: String(PORT) }, stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));

const sceneB64 = readFileSync(join(root, 'tests/fixtures/scene-four-people.jpg')).toString('base64');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`); };

// WEBGPU=1 npm run e2e → modeller (yazılım tabanlı) WebGPU ile çalışır; telefondaki GPU yolunu test eder
const gpuArgs = process.env.WEBGPU ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] : [];
const browser = await playwright.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', ...gpuArgs] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, permissions: ['camera'] });

await context.addInitScript(({ sceneB64 }) => {
  // Sahte kamera: fotoğraf + hareketli plaka
  const img = new Image();
  img.src = `data:image/jpeg;base64,${sceneB64}`;
  const canvas = document.createElement('canvas');
  canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  let t0 = performance.now();
  function draw() {
    const t = (performance.now() - t0) / 1000;
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 1920, 1080);
    if (img.complete) ctx.drawImage(img, 0, 0, 1920, 1537, 0, 0, 1350, 1080);
    // araç gövdesi ve plaka (yavaşça sağa-sola hareket eder)
    const px = 1430 + Math.sin(t * 0.6) * 30, py = 860;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(px - 60, py - 160, 560, 300);
    const pw = 440, ph = 96;
    ctx.fillStyle = '#111'; ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = '#1d3fa8'; ctx.fillRect(px, py, 48, ph);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 26px sans-serif'; ctx.font = 'bold 22px sans-serif'; ctx.fillText('TR', px + 8, py + 84);
    ctx.fillStyle = '#111';
    let fs = 86;
    do { ctx.font = `bold ${fs}px "DejaVu Sans", Arial, sans-serif`; fs -= 2; } while (ctx.measureText('34 ABC 123').width > pw - 80);
    ctx.textBaseline = 'middle';
    ctx.fillText('34 ABC 123', px + 60, py + ph / 2 + 4);
    ctx.textBaseline = 'alphabetic';
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  const stream = canvas.captureStream(30);
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => (c && c.video ? canvas.captureStream(30) : orig(c));
  window.__fakeStream = stream;
}, { sceneB64 });

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#setup-form:not([hidden])', { timeout: 60_000 });
  const coi = await page.evaluate(() => self.crossOriginIsolated);
  check('Service worker ile cross-origin isolation', coi);

  const tLoad = Date.now();
  // 4 haneli PIN: ikinci alan dolunca form kendiliğinden gönderilir
  await page.type('#setup-form [name=password]', '2468');
  await page.type('#setup-form [name=password2]', '2468');
  await page.waitForSelector('#app:not([hidden])', { timeout: 180_000 });
  check('Kurulum + model yükleme', true, `${((Date.now() - tLoad) / 1000).toFixed(1)} sn`);
  await page.screenshot({ path: join(out, '01-live-idle.png') });

  // Tanılama: model durumları
  await page.click('[data-tab=settings]');
  await page.waitForTimeout(500);
  const diag = await page.$eval('#diag', (el) => el.innerText);
  for (const k of ['Yüz algılama', 'Yüz doğrulama', 'Plaka OCR', 'Araç algılama']) {
    const line = diag.split('\n').find((l, i, a) => a[i - 1] === k) || '';
    check(`Model: ${k}`, /hazır/.test(line), line);
  }

  // Araç kaydı
  await page.click('[data-tab=vehicles]');
  await page.click('[data-action=vehicle-new]');
  await page.fill('#vehicle-form [name=plate]', '34abc123');
  await page.fill('#vehicle-form [name=owner]', 'Test Sahibi');
  await page.fill('#vehicle-form [name=company]', 'Örnek Lojistik A.Ş.');
  await page.click('#vehicle-form button[value=save]');
  await page.waitForTimeout(400);
  const vtext = await page.$eval('#vehicle-list', (el) => el.innerText);
  check('Araç kaydı oluşturma ve plaka biçimlendirme', vtext.includes('34 ABC 123'), vtext.split('\n')[0]);

  // Hatalı plaka reddi
  await page.click('[data-action=vehicle-new]');
  await page.fill('#vehicle-form [name=plate]', '99 QQ 1');
  await page.click('#vehicle-form button[value=save]');
  const verr = await page.$eval('#vehicle-form [data-error]', (el) => el.textContent);
  check('Geçersiz plaka reddedilir', /format/.test(verr), verr);
  await page.click('#vehicle-form button[value=cancel]');

  // Personel kaydı (biyometrik şablon)
  await page.click('[data-tab=personnel]');
  await page.click('[data-action=personnel-new]');
  await page.fill('#personnel-form [name=employeeNo]', 'P-001');
  await page.fill('#personnel-form [name=fullName]', 'Kayıtlı Personel A');
  await page.setInputFiles('#personnel-form [name=photo]', join(root, 'tests/fixtures/enroll-person-a.jpg'));
  await page.waitForTimeout(500);
  const consentErr = await page.$eval('#personnel-form [data-error]', (el) => el.textContent);
  check('Hukuki onay olmadan şablon çıkarılmaz', /aydınlatma|hukuki/i.test(consentErr), consentErr);
  await page.check('#personnel-form [name=informed]');
  await page.fill('#personnel-form [name=legalBasis]', 'Test – açık rıza belgesi 2026/1');
  await page.setInputFiles('#personnel-form [name=photo]', join(root, 'tests/fixtures/enroll-person-a.jpg'));
  await page.waitForFunction(() => /1 yüz şablonu/.test(document.querySelector('#personnel-form [data-templates]').textContent), null, { timeout: 60_000 })
    .catch(() => {});
  const tpl = await page.$eval('#personnel-form [data-templates]', (el) => el.textContent);
  check('Fotoğraftan yüz şablonu çıkarma', /1 yüz şablonu/.test(tpl), tpl + ' ' + await page.$eval('#personnel-form [data-error]', (el) => el.textContent));
  await page.click('#personnel-form button[value=save]');
  await page.waitForTimeout(400);
  const ptext = await page.$eval('#personnel-list', (el) => el.innerText);
  check('Personel kaydı', ptext.includes('Kayıtlı Personel A'), ptext.split('\n').slice(0, 2).join(' | '));

  // Canlı analiz
  await page.click('[data-tab=live]');
  await page.click('#btn-camera');
  const tStart = Date.now();
  await page.waitForFunction(() => document.querySelector('#plate-banner:not([hidden]) [data-plate]')?.textContent, null, { timeout: 90_000 }).catch(() => {});
  const banner = await page.$eval('#plate-banner [data-plate]', (el) => el.textContent).catch(() => '');
  const bannerSub = await page.$eval('#plate-banner [data-sub]', (el) => el.textContent).catch(() => '');
  check('Canlı plaka okuma (34 ABC 123)', banner === '34 ABC 123', `${banner} · ${bannerSub} · ${((Date.now() - tStart) / 1000).toFixed(1)} sn`);
  if (banner !== '34 ABC 123') {
    console.log(JSON.stringify(await page.evaluate(() => window.__analyzer.plateTracker.tracks.map((t) => ({
      id: t.id, box: t.box, score: t.scoreAvg, q: t.payload?.quality, attempts: t.data.attempts, raw: t.data.lastRaw, cand: t.data.candidate, hint: t.data.hint,
      votes: t.data.consensus?.votes,
    }))), null, 1));
  }
  check('Kayıtlı araç ile karşılaştırma', /Kayıtlı ve yetkili/.test(bannerSub), bannerSub);
  await page.screenshot({ path: join(out, '02-live-plate.png') });

  // Not: headless Chromium yazılım tabanlı WebGL (SwiftShader) kullanır; telefon GPU'suna göre çok yavaştır
  await page.waitForFunction(() => /Kayıtlı Personel A/.test(document.querySelector('#recent-list').innerText), null, { timeout: 150_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(out, '03-live-faces.png') });
  const recent = await page.$eval('#recent-list', (el) => el.innerText);
  check('Kayıtlı personel doğrulandı', /Kayıtlı Personel A/.test(recent), recent.split('\n').filter(Boolean).slice(0, 6).join(' | '));
  const faceThumb = await page.$eval('#recent-list .ico img.face', () => true).catch(() => false);
  check('Son algılamalarda yüz küçük resmi', faceThumb);

  const st = await page.evaluate(() => {
    const a = window.__analyzer;
    return a ? {
      faces: a.faceTracker.tracks.filter((t) => t.confirmed).map((t) => ({ id: t.id, result: t.data.result?.key, name: t.data.person?.fullName || null })),
      plates: a.plateTracker.tracks.filter((t) => t.confirmed).map((t) => ({ id: t.id, plate: t.data.plate, result: t.data.result?.key })),
    } : null;
  });
  if (st) {
    check('Birden fazla yüz eşzamanlı takip', st.faces.length >= 3, JSON.stringify(st.faces));
    const named = st.faces.filter((f) => f.name);
    check('Kayıtsız kişilere isim atanmadı', named.length <= 1 && named.every((f) => f.name === 'Kayıtlı Personel A'), `${named.length} isimli iz`);
  }

  // Takip numarası kararlılığı: okunan plakanın izi 10 sn boyunca aynı numarayı korumalı
  const plateTrackId = () => page.evaluate(() => window.__analyzer.plateTracker.tracks.filter((t) => t.data.plate === '34ABC123').map((t) => t.id).join(','));
  const ids1 = await plateTrackId();
  await page.waitForTimeout(10_000);
  const ids2 = await plateTrackId();
  check('Hareketli plakada takip numarası korunur', !!ids1 && ids1 === ids2, `${ids1} → ${ids2}`);

  const recentAll = await page.$eval('#recent-list', (el) => el.innerText);
  const plateEvents = recentAll.split('34 ABC 123').length - 1;
  check('Aynı plaka tekrar tekrar kaydedilmez', plateEvents === 1, `${plateEvents} kayıt`);
  check('Plaka olmayan desenler (jaluzi vb.) "okunamadı" olayı üretmez', !/Okunamadı/.test(recentAll));

  // Canlı görüntüden hızlı kayıt: "Yüzümü kaydet" → kare dondurulur → ad yazılır → tanınır
  await page.waitForSelector('#quick-enroll:not([hidden])', { timeout: 20_000 }).catch(() => {});
  const qeVisible = await page.$eval('#quick-enroll', (el) => !el.hidden);
  check('Yüz görülünce "Yüzümü kaydet" düğmesi çıkar', qeVisible);
  if (qeVisible) {
    await page.click('#qe-capture');
    await page.waitForFunction(() => /hazır|bulunamadı|yaklaşın|net değil|önden/.test(document.querySelector('#qe-msg').textContent), null, { timeout: 120_000 }).catch(() => {});
    const qeMsg = await page.$eval('#qe-msg', (el) => el.textContent);
    check('Görüntü donduruldu ve yüz bulundu', /hazır/.test(qeMsg), qeMsg);
    await page.screenshot({ path: join(out, '06-freeze.png') });
    await page.fill('#qe-name', 'Serkan Bilge');
    await page.click('#qe-save');
    await page.waitForTimeout(800);
    check('Kayıt penceresi kapandı', !(await page.$eval('#qe-dialog', (d) => d.open)));
    await page.waitForFunction(() => window.__analyzer.faceTracker.tracks.some((t) => t.data.person?.fullName === 'Serkan Bilge'), null, { timeout: 150_000 }).catch(() => {});
    const named = await page.evaluate(() => window.__analyzer.faceTracker.tracks.filter((t) => t.data.person).map((t) => t.data.person.fullName));
    check('Kaydedilen kişi kamerada adıyla tanınır', named.includes('Serkan Bilge'), JSON.stringify(named));
    await page.screenshot({ path: join(out, '06-quick-enroll.png') });
  }

  // Okunan plaka araç listesine otomatik eklenir (fotoğraf ve renk ile); sonra elle tamamlanır
  await page.click('[data-tab=vehicles]');
  await page.waitForTimeout(600);
  const vlist = await page.$eval('#vehicle-list', (el) => el.innerText);
  check('Okunan plaka araç listesinde', /34 ABC 123/.test(vlist), vlist.split('\n').slice(0, 4).join(' | '));
  const hasPhoto = await page.$eval('#vehicle-list .vthumb img', () => true).catch(() => false);
  check('Araç kaydında araç fotoğrafı var', hasPhoto);
  await page.click('#vehicle-list .rec');
  const seen = await page.$eval('#vehicle-seen', (el) => el.textContent);
  const diagModels = await page.evaluate(() => window.__app.models.vehicleMake);
  check('Araç görüntüsünden marka/model/tür/renk tahmini çalıştı', /Görüntüden tahmin/.test(seen), `${diagModels} · ${seen.slice(seen.indexOf('Görüntüden')).slice(0, 140)}`);
  await page.fill('#vehicle-form [name=owner]', 'Serkan Bilge');
  await page.fill('#vehicle-form [name=company]', 'Sade Ekonomi');
  await page.fill('#vehicle-form [name=brand]', 'Renault');
  await page.click('#vehicle-form button[value=save]');
  await page.waitForTimeout(500);
  const vlist2 = await page.$eval('#vehicle-list', (el) => el.innerText);
  check('Araç kaydına sahip ve şirket eklendi', /Serkan Bilge/.test(vlist2) && /Sade Ekonomi/.test(vlist2), vlist2.split('\n').slice(0, 5).join(' | '));
  await page.screenshot({ path: join(out, '07-vehicles.png') });
  await page.click('[data-tab=live]');

  const overflow = await page.evaluate(() => ({ sw: document.body.scrollWidth, w: window.innerWidth, ctl: [...document.querySelectorAll('.controls .ctl')].every((b) => b.getBoundingClientRect().right <= window.innerWidth) }));
  check('Telefon genişliğinde (412px) yatay taşma yok', overflow.sw <= overflow.w && overflow.ctl, JSON.stringify(overflow));
  // Arayüz akıcılığı: analiz çalışırken 6 sn boyunca ekran karelerinin arası (donma süresi)
  const jank = await page.evaluate(() => new Promise((resolve) => {
    let last = performance.now(), worst = 0, frames = 0;
    const t0 = last;
    const tick = (now) => {
      worst = Math.max(worst, now - last); last = now; frames++;
      if (now - t0 < 6000) requestAnimationFrame(tick); else resolve({ worst: Math.round(worst), fps: Math.round(frames / 6) });
    };
    requestAnimationFrame(tick);
  }));
  check('Analiz sırasında arayüz donmuyor', jank.worst < 700, `en uzun donma ${jank.worst} ms, ekran ${jank.fps} fps`);
  const perf = await page.$eval('#chip-perf', (el) => el.textContent);
  check('Performans göstergesi', /fps/.test(perf), perf);

  await page.click('[data-tab=events]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, '04-events.png'), fullPage: true });
  await page.click('[data-tab=settings]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '05-settings.png'), fullPage: true });
} catch (e) {
  check('E2E akışı', false, e.message);
  await page.screenshot({ path: join(out, 'error.png') }).catch(() => {});
} finally {
  const relevant = errors.filter((e) => !/favicon|DevTools/.test(e));
  check('Konsolda kritik hata yok', relevant.length === 0, relevant.slice(0, 5).join(' || '));
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} kontrol başarılı`);
  process.exit(failed ? 1 : 0);
}
