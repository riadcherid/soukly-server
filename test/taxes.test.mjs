// Tests des taxes TPS / TVQ (v0.7.12) — détaxation par produit.
// Décision de Riad (2026-11-19) : le café est détaxé (grains et
// moulu), même si son rayon Boissons est taxable ; le jus Ifruit
// reste taxé. Tests purs, sans base de données.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taxForLine, computeOrderTaxes } from '../src/taxes.js';

const catalog = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'data',
      'catalog.json',
    ),
    'utf8',
  ),
);

const byId = new Map(catalog.products.map((p) => [p.id, p]));

test('le café est détaxé dans catalog.json (grains id 19, moulu id 79), et rien d\'autre', () => {
  const exempt = catalog.products
    .filter((p) => p.tax_exempt === true)
    .map((p) => p.id)
    .sort((a, b) => a - b);
  assert.deepEqual(exempt, [19, 79]);
  assert.equal(byId.get(71)?.tax_exempt, undefined); // Jus Ifruit : taxé
});

test('café moulu (Boissons, 649 ¢) : ni TPS ni TVQ', () => {
  assert.deepEqual(
    taxForLine({ categoryKey: 'boissons', taxExempt: true, quantity: 1, lineTotalCents: 649 }),
    { tps: 0, tvq: 0 },
  );
});

test('café en grains (Boissons, 1299 ¢) : ni TPS ni TVQ', () => {
  assert.deepEqual(
    taxForLine({ categoryKey: 'boissons', taxExempt: true, quantity: 1, lineTotalCents: 1299 }),
    { tps: 0, tvq: 0 },
  );
});

test('jus Ifruit (Boissons, 249 ¢, sans flag) : TPS + TVQ', () => {
  // TPS 5 % de 249 = 12,45 → 12 ; TVQ 9,975 % de (249 + 12) = 26,03 → 26.
  assert.deepEqual(
    taxForLine({ categoryKey: 'boissons', quantity: 1, lineTotalCents: 249 }),
    { tps: 12, tvq: 26 },
  );
});

test('autre boisson sans flag (jus d\'orange frais, 549 ¢) : toujours taxée', () => {
  assert.deepEqual(
    taxForLine({ categoryKey: 'boissons', quantity: 1, lineTotalCents: 549 }),
    { tps: 27, tvq: 57 },
  );
});

test('restauration et ménagers (nouvelles clés) : TPS + TVQ ; anciennes clés et nouveaux rayons détaxés : 0', () => {
  // Nouvelles clés taxables (v0.7.18) : 1000 ¢ → TPS 50, TVQ 105.
  for (const key of [
    'restauration', 'produits-menagers-et-hygiene',
    'glaces-et-desserts-glaces', 'produits-pour-animaux',
  ]) {
    assert.deepEqual(
      taxForLine({ categoryKey: key, quantity: 1, lineTotalCents: 1000 }),
      { tps: 50, tvq: 105 },
      `rayon ${key}`,
    );
  }
  // Les anciennes clés ont disparu avec leurs rayons : le défaut
  // (détaxé) s'applique — même chose pour les nouveaux rayons
  // détaxés (épicerie bio, bébés).
  for (const key of [
    'jouets-et-jeux', 'grignotines', 'menager', 'animaux',
    'fleurs-et-plantes', 'fete', 'soins-personnels-et-beaute',
    'epicerie-bio-et-produits-naturels', 'produits-pour-bebes',
  ]) {
    assert.deepEqual(
      taxForLine({ categoryKey: key, quantity: 1, lineTotalCents: 1000 }),
      { tps: 0, tvq: 0 },
      `rayon ${key}`,
    );
  }
  // Le produit préparé reste taxable quel que soit son rayon.
  assert.deepEqual(
    taxForLine({ categoryKey: 'restauration', prepared: true, quantity: 1, lineTotalCents: 1399 }),
    { tps: 70, tvq: 147 },
  );
});

test('le flag détaxé l\'emporte même sur un produit préparé', () => {
  assert.deepEqual(
    taxForLine({ categoryKey: 'boissons', prepared: true, taxExempt: true, quantity: 1, lineTotalCents: 1000 }),
    { tps: 0, tvq: 0 },
  );
});

test('commande mixte : café détaxé, jus taxé, tomates détaxées, frais taxés', () => {
  const lines = [
    { categoryKey: 'boissons', taxExempt: true, quantity: 1, lineTotalCents: 1299 }, // café
    { categoryKey: 'boissons', quantity: 2, lineTotalCents: 498 }, // 2 jus Ifruit
    { categoryKey: 'fruits', quantity: 1, lineTotalCents: 500 }, // tomates
  ];
  // Jus (ligne 498 ¢) : TPS 25 (498 × 5 % = 24,90 → 25),
  // TVQ : (498 + 25) × 9,975 % = 52,17 → 52.
  // Livraison 299 ¢ : TPS 15, TVQ 31. Service 499 ¢ : TPS 25, TVQ 52.
  assert.deepEqual(computeOrderTaxes(lines, 299, 499), { tps_cents: 65, tvq_cents: 135 });
});
