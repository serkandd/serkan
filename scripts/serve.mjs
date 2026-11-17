#!/usr/bin/env node
/**
 * Yerel HTTPS sunucusu (geliştirme ve saha testi için).
 *
 *  - Kamera erişimi HTTPS gerektirdiğinden kendinden imzalı sertifika üretir (openssl).
 *  - COOP/COEP başlıklarını ekler (çok iş parçacıklı WASM).
 *  - Aynı ağdaki telefondan erişim için yerel IP adreslerini yazdırır.
 *
 * Kullanım:  npm start            → https://0.0.0.0:8443
 *            PORT=9000 npm start
 *            HTTP=1 npm start     → düz HTTP (yalnızca localhost testleri / ters vekil arkasında)
 */
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const port = Number(process.env.PORT || 8443);
const useHttp = !!process.env.HTTP;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.gz': 'application/octet-stream',
};

function handler(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(pub, path));
  if (!file.startsWith(pub)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
  const headers = {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=()',
    'Cache-Control': /\/(vendor|models)\//.test(path) ? 'public, max-age=604800' : 'no-cache',
  };
  if (path.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}

function ensureCert() {
  const dir = join(root, '.cert');
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    const ips = lanIps();
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
      '-keyout', key, '-out', cert, '-subj', '/CN=guvenlik-asistani', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    console.log('Kendinden imzalı sertifika üretildi (.cert/). Telefonda ilk açılışta "Gelişmiş → Devam et" seçin.');
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function lanIps() {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

const server = useHttp ? createHttp(handler) : createHttps(ensureCert(), handler);
server.listen(port, '0.0.0.0', () => {
  const proto = useHttp ? 'http' : 'https';
  console.log(`Güvenlik Asistanı yayında: ${proto}://localhost:${port}`);
  for (const ip of lanIps()) console.log(`  Telefondan: ${proto}://${ip}:${port}`);
});
