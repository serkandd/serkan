import test from 'node:test';
import assert from 'node:assert/strict';
import { localizePlates } from '../../public/js/detection/plate-localizer.js';
import { preprocessPlate, findBlueBandEnd } from '../../public/js/ocr/plate-preprocess.js';
import { cropRGBA, laplacianVariance, toGray, otsu } from '../../public/js/vision/imgproc.js';
import { iou } from '../../public/js/tracking/tracker.js';
import { makeScene } from './synthetic.js';

test('sentetik sahnede plaka bölgesi bulunur', () => {
  const { img, plate } = makeScene();
  const c = localizePlates(img);
  assert.ok(c.length >= 1, 'aday yok');
  const best = Math.max(...c.map((b) => iou(b, plate)));
  assert.ok(best > 0.5, `IoU ${best.toFixed(2)}`);
});

test('düz/plakasız sahnede aday üretilmez', () => {
  const { img } = makeScene({ text: '' });
  // plakayı kaldırmak için yeni boş sahne
  const blank = { width: 640, height: 360, data: new Uint8ClampedArray(640 * 360 * 4).fill(128) };
  assert.equal(localizePlates(blank).length, 0);
  assert.ok(img);
});

test('küçük (uzak) plaka da bulunur', () => {
  const { img, plate } = makeScene({ scale: 2, x: 200, y: 300 });
  const c = localizePlates(img);
  const best = Math.max(0, ...c.map((b) => iou(b, plate)));
  assert.ok(best > 0.4, `IoU ${best.toFixed(2)}`);
});

test('OCR ön işleme: mavi bant kırpılır, kalite ölçülür', () => {
  const { img, plate } = makeScene();
  const crop = cropRGBA(img, plate);
  assert.ok(findBlueBandEnd(crop) > 5);
  const { image, quality } = preprocessPlate(crop);
  assert.equal(quality.ok, true, quality.reason);
  assert.ok(quality.charCount >= 7, `karakter ${quality.charCount}`);
  assert.equal(image.height, 72 + 24);
});

test('bulanık plaka kalite kontrolünden geçmez', () => {
  const { img, plate } = makeScene({ scale: 1 });
  const crop = cropRGBA(img, plate);
  const { quality } = preprocessPlate(crop);
  assert.equal(quality.ok, false);
});

test('imgproc temel', () => {
  const g = toGray({ data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]), width: 2, height: 1 });
  assert.deepEqual([...g.data], [0, 255]);
  assert.ok(otsu(new Uint8Array([10, 10, 10, 200, 200, 200])) >= 10);
  assert.equal(laplacianVariance({ data: new Uint8Array(100).fill(9), width: 10, height: 10 }), 0);
});
