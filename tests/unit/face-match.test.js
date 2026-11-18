import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFace, euclidean, distanceToScore } from '../../public/js/detection/face-match.js';

function vec(seed) {
  let s = seed;
  const v = new Float32Array(128);
  for (let i = 0; i < 128; i++) { s = (s * 9301 + 49297) % 233280; v[i] = (s / 233280 - 0.5) * 0.18; }
  return v;
}
function near(v, eps) { return v.map((x, i) => x + (i % 2 ? eps : -eps)); }

const people = [
  { id: 'a', fullName: 'A', descriptors: [Array.from(vec(1))] },
  { id: 'b', fullName: 'B', descriptors: [Array.from(vec(2))] },
];

test('kayıtlı kişi eşleşir', () => {
  const r = matchFace(near(vec(1), 0.01), people, { threshold: 0.45, margin: 0.06 });
  assert.equal(r.matched, true);
  assert.equal(r.person.id, 'a');
});

test('kayıtsız kişiye isim atanmaz', () => {
  const r = matchFace(vec(99), people, { threshold: 0.45, margin: 0.06 });
  assert.equal(r.matched, false);
  assert.equal(r.person, undefined);
});

test('iki kişiye eşit yakın → belirsiz, eşleşme yok', () => {
  const a = vec(1), b = vec(2);
  const mid = a.map((x, i) => (x + b[i]) / 2);
  const close = [
    { id: 'a', descriptors: [Array.from(mid.map((x) => x + 0.001))] },
    { id: 'b', descriptors: [Array.from(mid.map((x) => x - 0.001))] },
  ];
  const r = matchFace(mid, close, { threshold: 0.6, margin: 0.06 });
  assert.equal(r.matched, false);
  assert.equal(r.reason, 'Belirsiz eşleşme');
});

test('şablonu olmayan personel atlanır', () => {
  const r = matchFace(vec(1), [{ id: 'x', descriptors: [] }]);
  assert.equal(r.matched, false);
});

test('skor dönüşümü', () => {
  assert.equal(distanceToScore(0.2), 100);
  assert.equal(distanceToScore(0.7), 0);
  assert.ok(euclidean([0, 0], [3, 4]) === 5);
});

import { cosine } from '../../public/js/detection/face-match.js';
import { similarityTransform, frontalFromKps } from '../../public/js/detection/face-engine-onnx.js';

function unit(seed, n = 512) {
  const v = new Float32Array(n); let q = 0;
  for (let i = 0; i < n; i++) { const h = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453; v[i] = h - Math.floor(h) - 0.5; q += v[i] * v[i]; }
  q = Math.sqrt(q); for (let i = 0; i < n; i++) v[i] /= q; return v;
}
function mix(a, b, t) { const v = a.map((x, i) => x * (1 - t) + b[i] * t); const q = Math.hypot(...v); return v.map((x) => x / q); }

test('ArcFace (512B): kosinüs eşleşmesi ve kayıtsız kişi', () => {
  const A = unit(11), B = unit(22), noise = unit(99);
  const people = [{ id: 'a', descriptors: [Array.from(A)] }, { id: 'b', descriptors: [Array.from(B)] }];
  const live = mix(A, noise, 0.4); // aynı kişi, farklı koşul
  const r = matchFace(live, people, { simThreshold: 0.42, simMargin: 0.07 });
  assert.equal(r.matched, true);
  assert.equal(r.person.id, 'a');
  assert.ok(r.similarity > 0.42);
  const stranger = matchFace(unit(1234), people, { simThreshold: 0.42 });
  assert.equal(stranger.matched, false);
  assert.ok(cosine(A, B) < 0.2);
});

test('ArcFace ve eski şablonlar karışmaz', () => {
  const people = [{ id: 'a', descriptors: [Array.from({ length: 128 }, () => 0.1)] }];
  assert.equal(matchFace(unit(5), people).matched, false);
});

test('yüz hizalama dönüşümü ve baş açısı', () => {
  const dst = [[38.29, 51.69], [73.53, 51.5], [56.02, 71.73], [41.54, 92.36], [70.72, 92.2]];
  const src = dst.map(([x, y]) => [x * 2 + 100, y * 2 + 50]); // 2 kat ölçek + öteleme
  const t = similarityTransform(src, dst);
  assert.ok(Math.abs(t.a - 0.5) < 1e-6 && Math.abs(t.b) < 1e-6);
  assert.ok(frontalFromKps(src) > 0.9);
  const turned = src.map(([x, y], i) => (i === 2 ? [x + 40, y] : [x, y])); // burun yana kaymış
  assert.ok(frontalFromKps(turned) < 0.5);
});
