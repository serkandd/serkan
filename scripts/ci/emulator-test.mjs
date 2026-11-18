#!/usr/bin/env node
/**
 * Android emülatöründe kurulu APK'nın WebView'ine Chrome DevTools protokolüyle (ham CDP) bağlanır,
 * ilk kurulumu yapar, modellerin yüklenmesini bekler, konsol hatalarını ve tanılama bilgisini
 * yazdırır, ekran görüntüsü alır. (GitHub Actions'ta çalışır, Node 22 yerleşik WebSocket kullanır.)
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let socket = '';
for (let i = 0; i < 60 && !socket; i++) {
  const l = sh('adb shell cat /proc/net/unix || true').split('\n').find((x) => x.includes('webview_devtools_remote'));
  if (l) socket = l.trim().split(/\s+/).pop().replace(/^@/, '');
  else await sleep(2000);
}
if (!socket) { console.log('WebView DevTools soketi bulunamadı'); process.exit(1); }
sh(`adb forward tcp:9222 localabstract:${socket}`);

let target;
for (let i = 0; i < 30 && !target; i++) {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json().catch(() => []);
  target = list.find((t) => t.type === 'page');
  if (!target) await sleep(1000);
}
console.log('Hedef:', target?.url);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500)}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push(`[exception] ${d.exception?.description || d.text}`.slice(0, 800));
  } else if (m.method === 'Log.entryAdded') {
    logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`.slice(0, 500));
  }
});
const cdp = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
await cdp('Runtime.enable');
await cdp('Log.enable');
await cdp('Page.enable');

const waitFor = async (expr, ms) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await evaluate(expr)) return true; await sleep(1000); }
  return false;
};

console.log('UA:', await evaluate('navigator.userAgent'));
const t0 = Date.now();
// PIN'siz kullanım: uygulama giriş ekranı olmadan açılmalı
await waitFor(`!document.querySelector('#app').hidden || !!document.querySelector('#login-form:not([hidden])')`, 120_000);
console.log('Giriş ekranı:', await evaluate(`document.querySelector('#auth').hidden ? 'yok (doğrudan açıldı)' : 'göründü: ' + document.querySelector('#auth').innerText.slice(0, 200).replace(/\\n/g, ' | ')`));
// Ws kapanırsa (WebView çökmesi) süreç sessizce bitmesin: kayıtları her durumda yazdır
const keepAlive = setInterval(() => {}, 1000);
ws.addEventListener('close', () => { console.log('!!! DevTools bağlantısı kapandı (WebView yeniden başladı/çöktü)'); for (const l of logs) console.log(l); clearInterval(keepAlive); process.exit(0); });
const opened = await waitFor(`!document.querySelector('#app').hidden`, 300_000);
if (!opened) { console.log('Ekran:', await evaluate(`document.body.innerText.slice(0, 400)`)); for (const l of logs) console.log(l); }
// Yeni kurulumda çıkan "eski kayıtlarınız var mı" penceresini kapat (yeni başla)
await waitFor(`!!document.querySelector('#restore-dialog[open]')`, 15_000);
console.log('Geri yükleme önerisi:', await evaluate(`document.querySelector('#restore-dialog').open ? 'gösterildi' : 'yok'`));
await evaluate(`document.querySelector('#restore-skip')?.click(), true`);
console.log(opened ? `Uygulama açıldı: ${((Date.now() - t0) / 1000).toFixed(1)} sn` : 'UYGULAMA AÇILMADI (300 sn)');
console.log('Açılış ekranı:', await evaluate(`document.querySelector('#boot').innerText`));
await sleep(20_000);
console.log('Modeller:', await evaluate(`JSON.stringify(window.__app?.models || {})`));
console.log('Durum:', await evaluate(`[...document.querySelectorAll('.chip')].map((c) => c.innerText.replace(/\\n/g, ' ')).join(' | ')`));
console.log('İzolasyon:', await evaluate('self.crossOriginIsolated'), 'Çekirdek:', await evaluate('navigator.hardwareConcurrency'));
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync('webview.png', Buffer.from(shot.result.data, 'base64'));
// Otomatik yedeğin yazılmasını bekle
await waitFor(`(() => { const d = [...document.querySelectorAll('#diag dt')]; return true; })()`, 1000);
await sleep(15_000);
console.log('Yedek durumu:', await evaluate(`JSON.stringify((window.__backupStatus && window.__backupStatus()) || null)`));
console.log('Capacitor:', await evaluate(`JSON.stringify({ native: window.Capacitor?.isNativePlatform?.(), fsAvail: window.Capacitor?.isPluginAvailable?.('Filesystem'), plugins: Object.keys(window.Capacitor?.Plugins || {}), backupAvail: window.__backup?.autoBackupAvailable() })`));
console.log('Elle yedek:', await evaluate(`window.__backup.writeBackupToDevice().then((r) => 'OK ' + JSON.stringify(r), (e) => 'HATA ' + (e?.message || e) + ' ' + JSON.stringify(e))`));
console.log('--- Konsol ---');
for (const l of logs) console.log(l);
ws.close();
