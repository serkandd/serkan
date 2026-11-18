import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../../public/js/detection/vehicle-attributes.js';

const g = (make, type = [{ label: 'Sedan', p: 0.8 }], color = [{ label: 'Beyaz', p: 0.7 }]) => ({ make, type, color });

test('emin marka ve model yazılır', () => {
  const r = interpret(g([{ label: 'Fiat|Egea', p: 0.7 }, { label: 'Fiat|Linea', p: 0.1 }, { label: 'Renault|Clio', p: 0.05 }]));
  assert.equal(r.brand, 'Fiat'); assert.equal(r.model, 'Egea'); assert.equal(r.type, 'Sedan'); assert.equal(r.color, 'Beyaz');
});

test('marka emin, model belirsiz → yalnızca marka', () => {
  const r = interpret(g([{ label: 'Renault|Clio', p: 0.3 }, { label: 'Renault|Symbol', p: 0.28 }, { label: 'Renault|Taliant', p: 0.2 }, { label: 'Fiat|Egea', p: 0.05 }]));
  assert.equal(r.brand, 'Renault'); assert.equal(r.model, '');
});

test('belirsiz tahmin yazılmaz (yanlış bilgi yerine boş)', () => {
  const r = interpret(g([{ label: 'Mercedes-Benz|Travego', p: 0.21 }, { label: 'Mercedes-Benz|Citaro', p: 0.12 }, { label: 'Renault|Austral', p: 0.1 }],
    [{ label: 'Otobüs', p: 0.9 }], [{ label: 'Mavi', p: 0.4 }]));
  assert.equal(r.brand, ''); assert.equal(r.model, ''); assert.equal(r.type, 'Otobüs'); assert.equal(r.color, '');
});
