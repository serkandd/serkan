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
