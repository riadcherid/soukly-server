// Tests du tableau de bord (v0.7.9) — période et validation.
//
// Tests purs (pas de base) : la partie SQL est vérifiée en curl
// contre le serveur local (voir ~/workspace/verify-stats.sh).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidDate,
  lineMarginCents,
  marginPercent,
  parseRange,
} from '../src/stats.js';

test('isValidDate accepte AAAA-MM-JJ et refuse le reste', () => {
  assert.equal(isValidDate('2026-11-19'), true);
  assert.equal(isValidDate('19/11/2026'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate(''), false);
  assert.equal(isValidDate(null), false);
});

test('parseRange : défaut = 30 derniers jours jusqu’à aujourd’hui', () => {
  const { from, to } = parseRange({});
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Toronto',
  });
  assert.equal(to, today);
  assert.equal(
    (Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000),
    29,
  );
});

test('parseRange : période explicite acceptée', () => {
  assert.deepEqual(parseRange({ from: '2026-11-01', to: '2026-11-19' }), {
    from: '2026-11-01',
    to: '2026-11-19',
  });
});

test('parseRange : date invalide → date_invalid', () => {
  assert.throws(() => parseRange({ from: 'hier', to: '2026-11-19' }), (e) => e.code === 'date_invalid');
});

test('parseRange : from après to → range_invalid', () => {
  assert.throws(() => parseRange({ from: '2026-11-19', to: '2026-11-01' }), (e) => e.code === 'range_invalid');
});

test('parseRange : plus de 365 jours → range_too_long', () => {
  assert.throws(
    () => parseRange({ from: '2025-01-01', to: '2026-11-19' }),
    (e) => e.code === 'range_too_long',
  );
});

// Marge (v0.7.14) : (prix de vente − prix d'achat) × quantité.
// Ex. de référence : achat 500, vente 575 → marge 75, +15 %.
test('lineMarginCents : pièce, achat 500 / vente 575 → marge 75', () => {
  assert.equal(
    lineMarginCents({ line_total_cents: 575, quantity: 1, purchase_price_cents: 500 }),
    75,
  );
  assert.equal(
    lineMarginCents({ line_total_cents: 1725, quantity: 3, purchase_price_cents: 500 }),
    225,
  );
});

test('lineMarginCents : au poids, poids pesé sinon estimé', () => {
  // 1 kg à 575 $/kg vendu, acheté 500 $/kg → marge 75.
  assert.equal(
    lineMarginCents({ line_total_cents: 575, weight_grams: 1000, purchase_price_cents: 500 }),
    75,
  );
  // Estimé 500 g (288), pesé 480 g (276) : le coût suit le poids pesé.
  assert.equal(
    lineMarginCents({
      line_total_cents: 276, weight_grams: 500,
      collected_weight_grams: 480, purchase_price_cents: 500,
    }),
    36,
  );
});

test('lineMarginCents : manquant → 0 ; sans prix d’achat figé → marge = total', () => {
  assert.equal(
    lineMarginCents({ line_total_cents: 0, quantity: 1, status: 'manquant', purchase_price_cents: 500 }),
    0,
  );
  assert.equal(
    lineMarginCents({ line_total_cents: 575, quantity: 1, purchase_price_cents: null }),
    575,
  );
});

test('marginPercent : achat 500 / vente 575 → +15 % ; achat 0 → null', () => {
  assert.equal(marginPercent(500, 575), 15);
  assert.equal(marginPercent(1000, 900), -10);
  assert.equal(marginPercent(0, 575), null);
  assert.equal(marginPercent(null, 575), null);
});
