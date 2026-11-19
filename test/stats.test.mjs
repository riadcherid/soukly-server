// Tests du tableau de bord (v0.7.9) — période et validation.
//
// Tests purs (pas de base) : la partie SQL est vérifiée en curl
// contre le serveur local (voir ~/workspace/verify-stats.sh).
import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidDate, parseRange } from '../src/stats.js';

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
