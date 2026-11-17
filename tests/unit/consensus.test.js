import test from 'node:test';
import assert from 'node:assert/strict';
import { Consensus, Deduplicator } from '../../public/js/tracking/consensus.js';

test('tutarlı okumalar kesinleşir', () => {
  const c = new Consensus({ minVotes: 2, minAvgConf: 0.6 });
  c.add('34ABC123', 0.8);
  assert.equal(c.result().decided, false);
  c.add('34ABC123', 0.75);
  assert.equal(c.result().decided, true);
  assert.equal(c.result().value, '34ABC123');
});

test('çelişkili okumalar kesinleşmez', () => {
  const c = new Consensus({ minVotes: 2, minAgreement: 0.6 });
  c.add('34ABC123', 0.7); c.add('34ABC128', 0.7); c.add('34A8C123', 0.7);
  assert.equal(c.result().decided, false);
});

test('düşük güvenli okumalar kesinleşmez', () => {
  const c = new Consensus({ minVotes: 2, minAvgConf: 0.6 });
  c.add('34ABC123', 0.4); c.add('34ABC123', 0.45); c.add('34ABC123', 0.5);
  assert.equal(c.result().decided, false);
});

test('başarısız okumalar uzlaşıyı zayıflatır', () => {
  const c = new Consensus({ minVotes: 2, minAgreement: 0.6 });
  c.add('34ABC123', 0.65);
  for (let i = 0; i < 6; i++) c.addFailure();
  c.add('34ABC123', 0.65);
  assert.equal(c.result().decided, false);
});

test('tekrar bildirim engellenir', () => {
  const d = new Deduplicator(60_000);
  assert.equal(d.shouldEmit('34ABC123', 0), true);
  assert.equal(d.shouldEmit('34ABC123', 10_000), false);
  assert.equal(d.shouldEmit('06XY99', 10_000), true);
  assert.equal(d.shouldEmit('34ABC123', 200_000), true);
});
