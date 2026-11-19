// Tests du catalogue (v0.7.18) — nouvelle liste de 18 rayons de Riad
// (2026-11-19, avec un grand rayon « Restauration » pour les préparés)
// + produits des reçus Épilys du 09 et 19 nov. 2026 (32 nouveaux,
// 10 prix fixés).
//
// Vérifie catalog.json (la source du seed) : les 18 rayons, les
// renommages (poulet → volailles, etc.), les 3 préparés en
// Restauration, et la suppression des 7 rayons vides. Ne touche pas
// à la base : la migration en base est vérifiée en curl contre le
// serveur local (voir ~/workspace/verify-rayons-18.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('le catalogue a 18 rayons et 99 produits', () => {
  assert.equal(catalog.categories.length, 18);
  assert.equal(catalog.products.length, 99);
});

test('chaque produit est dans un rayon qui existe, sans doublon de tri', () => {
  const keys = new Set(catalog.categories.map((c) => c.key));
  const sorts = catalog.categories.map((c) => c.sort);
  assert.equal(new Set(sorts).size, sorts.length);
  assert.deepEqual([...sorts].sort((a, b) => a - b), Array.from({ length: 18 }, (_, i) => i + 1));
  for (const p of catalog.products) {
    assert.ok(keys.has(p.category), `produit ${p.id} (${p.name}) : rayon ${p.category} inconnu`);
  }
  const ids = catalog.products.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('les 18 rayons sont ceux de Riad, dans l’ordre, et les anciens ont disparu', () => {
  const keys = catalog.categories.map((c) => c.key);
  assert.deepEqual(keys, [
    'fruits', 'legumes', 'viandes-halal', 'volailles',
    'poissons-et-fruits-de-mer', 'produits-laitiers-et-oeufs',
    'boulangerie', 'patisserie', 'epicerie-seche',
    'produits-orientaux-et-maghrebins', 'surgeles', 'boissons',
    'produits-menagers-et-hygiene', 'restauration',
    'glaces-et-desserts-glaces', 'epicerie-bio-et-produits-naturels',
    'produits-pour-bebes', 'produits-pour-animaux',
  ]);
  const byKey = new Map(catalog.categories.map((c) => [c.key, c]));
  assert.equal(byKey.get('epicerie-seche')?.label, 'Épicerie sèche');
  assert.equal(byKey.get('volailles')?.label, 'Volailles');
  assert.equal(byKey.get('restauration')?.label, 'Restauration');
  for (const gone of [
    'poulet', 'poissons', 'laitages-oeufs', 'orientaux-maghrebins',
    'menager', 'promotions', 'grignotines', 'soins-personnels-et-beaute',
    'bebe-et-enfant', 'animaux', 'sante', 'fleurs-et-plantes', 'fete',
    'jouets-et-jeux', 'viandes-poissons',
  ]) {
    assert.ok(!keys.includes(gone), `rayon ${gone} encore présent`);
    assert.ok(!catalog.products.some((p) => p.category === gone), `produit encore en ${gone}`);
  }
});

test('les rayons renommés et la Restauration contiennent les bons produits', () => {
  const inCategory = (key) =>
    catalog.products.filter((p) => p.category === key).map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(inCategory('viandes-halal'), [6, 61, 62, 63]);
  assert.deepEqual(inCategory('volailles'), [5, 37, 38, 40, 59, 60]);
  assert.deepEqual(inCategory('poissons-et-fruits-de-mer'), [7, 39, 64]);
  assert.deepEqual(inCategory('produits-laitiers-et-oeufs'), [8, 9, 10, 68, 72]);
  assert.deepEqual(inCategory('produits-orientaux-et-maghrebins'), [41]);
  assert.deepEqual(inCategory('produits-menagers-et-hygiene'), [23, 24]);
  // Les 3 préparés, et eux seuls, sont en Restauration.
  assert.deepEqual(inCategory('restauration'), [93, 97, 98]);
  // Les 4 nouveaux rayons vides pour l'instant.
  for (const key of [
    'glaces-et-desserts-glaces', 'epicerie-bio-et-produits-naturels',
    'produits-pour-bebes', 'produits-pour-animaux',
  ]) {
    assert.deepEqual(inCategory(key), [], `rayon ${key} pas vide`);
  }
});

// Produits des reçus Épilys (v0.7.11) : 32 nouveaux (ids 68-99), prix
// des reçus, aucun doublon de nom avec les 67 premiers.
test('les 32 produits des reçus sont présents, avec les prix des reçus', () => {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const expected = {
    68: { price_cents: 499, category: 'produits-laitiers-et-oeufs' },
    69: { price_cents: 399, category: 'epicerie-seche' },
    70: { price_cents: 1149, category: 'epicerie-seche' },
    71: { price_cents: 249, category: 'boissons', deposit_cents: 10 },
    72: { price_cents: 389, category: 'produits-laitiers-et-oeufs' },
    73: { price_cents: 199, category: 'epicerie-seche' },
    74: { price_cents: 399, category: 'epicerie-seche' },
    75: { price_cents: 149, category: 'epicerie-seche' },
    76: { price_cents: 549, category: 'epicerie-seche' },
    77: { price_cents: 399, category: 'epicerie-seche' },
    78: { price_cents: 399, category: 'epicerie-seche' },
    79: { price_cents: 649, category: 'boissons' },
    80: { price_cents: 399, category: 'epicerie-seche' },
    81: { price_cents: 149, category: 'epicerie-seche' },
    82: { price_cents: 249, category: 'epicerie-seche' },
    83: { price_cents: 149, category: 'epicerie-seche' },
    84: { price_cents: 399, category: 'epicerie-seche' },
    85: { price_cents: 249, category: 'epicerie-seche' },
    86: { price_cents: 429, category: 'epicerie-seche' },
    87: { price_cents: 399, category: 'epicerie-seche' },
    88: { price_cents: 499, category: 'epicerie-seche' },
    89: { price_cents: 249, category: 'epicerie-seche' },
    90: { price_cents: 99, category: 'epicerie-seche' },
    91: { price_cents: 229, category: 'epicerie-seche' },
    92: { price_cents: 218, category: 'fruits', sold_by_weight: true },
    93: { price_cents: 1399, category: 'restauration', prepared: true },
    94: { price_cents: 49, category: 'boulangerie' },
    95: { price_cents: 99, category: 'legumes' },
    96: { price_cents: 149, category: 'epicerie-seche' },
    97: { price_cents: 399, category: 'restauration', prepared: true },
    98: { price_cents: 299, category: 'restauration', prepared: true },
    99: { price_cents: 49, category: 'boulangerie' },
  };
  for (const [id, want] of Object.entries(expected)) {
    const p = byId.get(Number(id));
    assert.ok(p, `produit ${id} absent`);
    assert.equal(p.price_cents, want.price_cents, `produit ${id} (${p.name}) : prix`);
    assert.equal(p.category, want.category, `produit ${id} (${p.name}) : rayon`);
    if (want.deposit_cents !== undefined) {
      assert.equal(p.deposit_cents, want.deposit_cents, `produit ${id} : consigne`);
    }
    if (want.sold_by_weight !== undefined) {
      assert.equal(p.sold_by_weight, want.sold_by_weight, `produit ${id} : au poids`);
    }
    if (want.prepared !== undefined) {
      assert.equal(p.prepared, want.prepared, `produit ${id} : préparé`);
    }
  }
  const names = catalog.products.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'noms en double');
});

// Prix fixés depuis les reçus pour les produits déjà présents à 0 $.
test('les 10 prix à 0 $ sont fixés depuis les reçus (au kg pour le poids)', () => {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const expected = {
    25: 284, 26: 109, 35: 879, 36: 659, 45: 958,
    48: 249, 56: 498, 57: 99, 60: 1199, 63: 1999,
  };
  for (const [id, price] of Object.entries(expected)) {
    assert.equal(byId.get(Number(id)).price_cents, price, `produit ${id}`);
  }
  // Grenades : vendues au kg chez Épilys, plus à la pièce.
  const grenades = byId.get(35);
  assert.equal(grenades.sold_by_weight, true);
  assert.equal(grenades.unit, 'le kg');
});

// Deux prix (v0.7.14) : chaque produit a un prix d'achat dans
// catalog.json — c'est la source du seed. Les prix actuels viennent
// des reçus Épilys, ce sont donc les prix d'achat : à la migration,
// purchase_price_cents = price_cents et le prix de vente ne bouge pas.
test('chaque produit a un prix d’achat (égal au prix de vente actuel)', () => {
  for (const p of catalog.products) {
    assert.ok(
      Number.isInteger(p.purchase_price_cents) && p.purchase_price_cents >= 0,
      `produit ${p.id} (${p.name}) : prix d'achat manquant`,
    );
    assert.equal(
      p.purchase_price_cents,
      p.price_cents,
      `produit ${p.id} (${p.name}) : le prix d'achat doit égaler le prix de vente actuel`,
    );
  }
});
