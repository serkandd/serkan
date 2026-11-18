#!/usr/bin/env node
/**
 * Üçüncü taraf kütüphaneleri ve model dosyalarını node_modules'tan public/vendor ve
 * public/models altına kopyalar. Böylece uygulama hiçbir CDN'e bağlı olmadan,
 * tamamen yerelden (ve PWA olarak çevrimdışı) çalışır.
 *
 * Kullanım: npm run vendor
 */
import { cpSync, mkdirSync, existsSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const pub = join(root, 'public');

function copy(src, dst) {
  const s = join(nm, src);
  const d = join(pub, dst);
  if (!existsSync(s)) throw new Error(`Bulunamadı: ${s} (önce "npm install" çalıştırın)`);
  mkdirSync(dirname(d), { recursive: true });
  cpSync(s, d);
  console.log(`  ${src} → public/${dst}`);
}

console.log('face-api (TensorFlow.js dahil) ve yüz modelleri');
copy('@vladmandic/face-api/dist/face-api.esm.js', 'vendor/face-api/face-api.esm.js');
for (const f of [
  'tiny_face_detector_model', 'ssd_mobilenetv1_model',
  'face_landmark_68_model', 'face_recognition_model',
]) {
  copy(`@vladmandic/face-api/model/${f}-weights_manifest.json`, `models/face/${f}-weights_manifest.json`);
  copy(`@vladmandic/face-api/model/${f}.bin`, `models/face/${f}.bin`);
}

console.log('Tesseract.js OCR');
copy('tesseract.js/dist/tesseract.esm.min.js', 'vendor/tesseract/tesseract.esm.min.js');
copy('tesseract.js/dist/worker.min.js', 'vendor/tesseract/worker.min.js');
for (const f of readdirSync(join(nm, 'tesseract.js-core'))) {
  // Yalnızca LSTM çekirdekleri (gömülü wasm içeren .wasm.js dosyaları)
  if (/^tesseract-core.*lstm\.wasm\.js$/.test(f)) copy(`tesseract.js-core/${f}`, `vendor/tesseract/core/${f}`);
}
// Android paketleyicisi .gz uzantılı varlıkları APK'ya almadığından dosya ".wasm" ekiyle saklanır
// (bkz. js/workers/tesseract-worker.js)
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'vendor/tesseract/lang/eng.traineddata.gz.wasm');

console.log('ONNX Runtime Web (WebGPU + WASM SIMD)');
rmSync(join(pub, 'vendor/ort'), { recursive: true, force: true });
copy('onnxruntime-web/dist/ort.min.mjs', 'vendor/ort/ort.min.mjs');
copy('onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'vendor/ort/ort-wasm-simd-threaded.jsep.mjs');
copy('onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'vendor/ort/ort-wasm-simd-threaded.jsep.wasm');

// Service worker önbellek listesi (çevrimdışı çalışma için)
const files = [];
function walk(dir, rel = '') {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const r = rel ? `${rel}/${f}` : f;
    if (statSync(p).isDirectory()) walk(p, r);
    else if (!/\.(map|md)$/.test(f) && f !== 'precache-manifest.json') files.push(r);
  }
}
walk(pub);
const manifest = { version: Date.now(), files: files.filter((f) => f !== 'sw.js').sort() };
writeFileSync(join(pub, 'precache-manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`precache-manifest.json: ${manifest.files.length} dosya`);
