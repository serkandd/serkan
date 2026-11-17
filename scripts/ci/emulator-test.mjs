#!/usr/bin/env node
/**
 * Android emülatöründe kurulu APK'nın WebView'ine Chrome DevTools protokolüyle bağlanır,
 * ilk kurulumu yapar, modellerin yüklenmesini bekler, konsol hatalarını ve tanılama
 * bilgisini yazdırır, ekran görüntüsü alır. (GitHub Actions'ta çalışır.)
 */
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let socket = '';
for (let i = 0; i < 60 && !socket; i++) {
  const lines = sh('adb shell cat /proc/net/unix || true').split('\n');
  const l = lines.find((x) => x.includes('webview_devtools_remote'));
  if (l) socket = l.trim().split(/\s+/).pop().replace(/^@/, '');
  else await sleep(2000);
}
if (!socket) { console.log('WebView DevTools soketi bulunamadı'); process.exit(1); }
sh(`adb forward tcp:9222 localabstract:${socket}`);
console.log('DevTools soketi:', socket);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages()[0];
for (let i = 0; i < 30 && !page; i++) { await sleep(1000); page = ctx.pages()[0]; }
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
console.log('URL:', page.url(), 'UA:', await page.evaluate(() => navigator.userAgent));

const t0 = Date.now();
try {
  await page.waitForSelector('#setup-form:not([hidden]), #login-form:not([hidden])', { timeout: 60_000 });
  if (await page.$('#setup-form:not([hidden])')) {
    await page.fill('#setup-form [name=password]', 'TestParola2026');
    await page.fill('#setup-form [name=password2]', 'TestParola2026');
    await page.click('#setup-form button[type=submit]');
  }
  await page.waitForSelector('#app:not([hidden])', { timeout: 300_000 });
  console.log(`Uygulama açıldı: ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
} catch (e) {
  console.log('HATA:', e.message);
  console.log('Açılış adımları:', await page.$eval('#boot', (el) => el.innerText).catch(() => '-'));
}
await sleep(15_000);
await page.screenshot({ path: 'emulator-live.png' }).catch(() => {});
const diag = await page.evaluate(() => JSON.stringify(window.__app?.models || {}, null, 1)).catch(() => '-');
console.log('Modeller:', diag);
const status = await page.evaluate(() => [...document.querySelectorAll('.chip')].map((c) => c.innerText.replace(/\n/g, ' ')).join(' | ')).catch(() => '-');
console.log('Durum:', status);
console.log('--- Konsol ---');
for (const l of logs) console.log(l);
await browser.close().catch(() => {});
