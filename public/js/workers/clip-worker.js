/**
 * Araç özellikleri (marka/model, kasa tipi, renk) — CLIP ViT-B/32 sıfır-atış sınıflandırma.
 * Ağır model olduğu için kendi Web Worker'ında, kendi ONNX Runtime örneğiyle çalışır;
 * yüz ve plaka analizini yavaşlatmaz.
 *
 *   → {type:'init'}                              ← {type:'ready'} | {type:'error', message}
 *   → {type:'classify', id, rgba(224×224×4)}     ← {type:'result', id, groups:{make,type,color}}
 */
import * as ort from '../../vendor/ort/ort.min.mjs';

const BASE = new URL('../../models/vehicle-clip/', import.meta.url).href;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
let session = null;
let groups = null;
let scale = 100;

function decodeF16(b64, n, dim) {
  const bin = atob(b64);
  const u16 = new Uint16Array(bin.length / 2);
  for (let i = 0; i < u16.length; i++) u16[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], s = h >> 15, e = (h >> 10) & 31, f = h & 1023;
    const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15);
    out[i] = s ? -v : v;
  }
  return { n, dim, data: out };
}

async function fetchBytes(url) {
  for (const u of [url, `${url}.wasm`]) {
    const r = await fetch(u).catch(() => null);
    if (r?.ok && !(r.headers.get('content-type') || '').includes('text/html')) return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error(`İndirilemedi: ${url}`);
}

async function init() {
  ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  const lab = await (await fetch(`${BASE}labels.json`)).json();
  scale = lab.logitScale || 100;
  groups = {};
  for (const g of ['make', 'type', 'color']) {
    groups[g] = { labels: lab[g].labels, emb: decodeF16(lab[g].embeddings_f16_b64, lab[g].labels.length, lab.dim) };
  }
  session = await ort.InferenceSession.create(await fetchBytes(`${BASE}visual-int8.onnx`), {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
  });
}

function classify(rgba) {
  const area = 224 * 224;
  const f = new Float32Array(3 * area);
  for (let i = 0, j = 0; i < area; i++, j += 4) {
    for (let c = 0; c < 3; c++) f[c * area + i] = (rgba[j + c] / 255 - MEAN[c]) / STD[c];
  }
  return session.run({ pixel_values: new ort.Tensor('float32', f, [1, 3, 224, 224]) }).then((out) => {
    const e = out[session.outputNames[0]].data;
    let q = 0;
    for (let i = 0; i < e.length; i++) q += e[i] * e[i];
    q = Math.sqrt(q) || 1;
    const res = {};
    for (const [g, { labels, emb }] of Object.entries(groups)) {
      const logits = new Float32Array(emb.n);
      let max = -Infinity;
      for (let k = 0; k < emb.n; k++) {
        let s = 0;
        for (let d = 0; d < emb.dim; d++) s += emb.data[k * emb.dim + d] * e[d];
        logits[k] = (scale * s) / q;
        if (logits[k] > max) max = logits[k];
      }
      let sum = 0;
      for (let k = 0; k < emb.n; k++) { logits[k] = Math.exp(logits[k] - max); sum += logits[k]; }
      const probs = Array.from(logits, (v, k) => ({ label: labels[k], p: v / sum })).sort((a, b) => b.p - a.p);
      res[g] = probs.slice(0, 8);
    }
    return res;
  });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') { await init(); self.postMessage({ type: 'ready' }); }
    if (m.type === 'classify') self.postMessage({ type: 'result', id: m.id, groups: await classify(m.rgba) });
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e?.message || e) });
  }
};
