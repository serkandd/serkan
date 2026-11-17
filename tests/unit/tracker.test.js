import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiObjectTracker, iou } from '../../public/js/tracking/tracker.js';

test('iou', () => {
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1);
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }), 0);
});

test('hareket eden nesne aynı numarayı korur', () => {
  const tr = new MultiObjectTracker({ idPrefix: 'Y', minHits: 2 });
  let t = 0;
  const ids = new Set();
  for (let i = 0; i < 30; i++) {
    t += 66;
    const tracks = tr.update([{ box: { x: 100 + i * 6, y: 100 + i * 2, w: 80, h: 80 }, score: 0.9 }], t);
    if (tracks[0].id) ids.add(tracks[0].id);
  }
  assert.equal(ids.size, 1);
  assert.equal(tr.confirmedCount, 1);
});

test('birden fazla nesne ayrı numaralar alır ve karışmaz', () => {
  const tr = new MultiObjectTracker({ idPrefix: 'P', minHits: 2 });
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 100;
    tr.update([
      { box: { x: 50 + i * 4, y: 50, w: 60, h: 20 } },
      { box: { x: 500 - i * 4, y: 300, w: 60, h: 20 } },
    ], t);
  }
  const snap = tr.snapshot(t);
  assert.equal(snap.length, 2);
  const [a, b] = snap.sort((p, q) => p.box.y - q.box.y);
  assert.notEqual(a.track.id, b.track.id);
  assert.ok(a.box.x > 100 && b.box.x < 450);
});

test('tek karelik yanlış tespit onaylanmaz ve numara harcamaz', () => {
  const tr = new MultiObjectTracker({ idPrefix: 'Y', minHits: 2 });
  tr.update([{ box: { x: 10, y: 10, w: 30, h: 30 } }], 0);
  tr.update([], 100);
  tr.update([], 600);
  assert.equal(tr.tracks.length, 0);
  tr.update([{ box: { x: 300, y: 10, w: 30, h: 30 } }], 700);
  tr.update([{ box: { x: 302, y: 10, w: 30, h: 30 } }], 760);
  assert.equal(tr.snapshot(760)[0].track.id, 'Y1');
});

test('kısa süre kaybolan nesne aynı numarayla devam eder', () => {
  const tr = new MultiObjectTracker({ idPrefix: 'Y', minHits: 2, maxAgeMs: 1500 });
  tr.update([{ box: { x: 100, y: 100, w: 50, h: 50 } }], 0);
  tr.update([{ box: { x: 102, y: 100, w: 50, h: 50 } }], 100);
  const id = tr.tracks[0].id;
  tr.update([], 400);
  tr.update([], 800);
  tr.update([{ box: { x: 106, y: 101, w: 50, h: 50 } }], 1000);
  assert.equal(tr.tracks.length, 1);
  assert.equal(tr.tracks[0].id, id);
});

test('yumuşatma titreşimi azaltır', () => {
  const tr = new MultiObjectTracker({ minHits: 1 });
  let maxJump = 0, prev = null;
  for (let i = 0; i < 40; i++) {
    const noise = (i % 2 ? 1 : -1) * 6;
    tr.update([{ box: { x: 200 + noise, y: 200, w: 60, h: 60 } }], i * 66);
    const x = tr.tracks[0].box.x;
    if (prev != null && i > 5) maxJump = Math.max(maxJump, Math.abs(x - prev));
    prev = x;
  }
  assert.ok(maxJump < 12, `sıçrama ${maxJump}`);
});
