// Tests du catalogue (v0.7.11) — refonte des rayons (v0.7.8) + produits
// des reçus Épilys du 09 et 19 nov. 2026 (32 nouveaux, 10 prix fixés).
//
// Vérifie catalog.json (la source du seed) : « Viandes et poissons »
// est scindé en « Viandes halal », « Poulet », « Poissons », et le
// rayon « Orientaux et Maghrébins » existe. Ne touche pas à la base :
// la migration en base est vérifiée en curl contre le serveur local
// (voir ~/workspace/verify-categories.sh).
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

test('le catalogue a 22 rayons et 99 produits', () => {
  assert.equal(catalog.categories.length, 22);
  assert.equal(catalog.products.length, 99);
});

test('chaque produit est dans un rayon qui existe, sans doublon de tri', () => {
  const keys = new Set(catalog.categories.map((c) => c.key));
  const sorts = catalog.categories.map((c) => c.sort);
  assert.equal(new Set(sorts).size, sorts.length);
  assert.deepEqual([...sorts].sort((a, b) => a - b), Array.from({ length: 22 }, (_, i) => i + 1));
  for (const p of catalog.products) {
    assert.ok(keys.has(p.category), `produit ${p.id} (${p.name}) : rayon ${p.category} inconnu`);
  }
  const ids = catalog.products.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('le rayon fusionné « Viandes et poissons » a disparu', () => {
  const keys = catalog.categories.map((c) => c.key);
  assert.ok(!keys.includes('viandes-poissons'));
  assert.ok(!catalog.products.some((p) => p.category === 'viandes-poissons'));
});

test('les trois nouveaux rayons existent, avec les bons produits', () => {
  const byKey = new Map(catalog.categories.map((c) => [c.key, c]));
  assert.equal(byKey.get('viandes-halal')?.label, 'Viandes halal');
  assert.equal(byKey.get('poulet')?.label, 'Poulet');
  assert.equal(byKey.get('poissons')?.label, 'Poissons');
  assert.equal(byKey.get('orientaux-maghrebins')?.label, 'Orientaux et Maghrébins');
  const inCategory = (key) =>
    catalog.products.filter((p) => p.category === key).map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(inCategory('viandes-halal'), [6, 61, 62, 63]);
  assert.deepEqual(inCategory('poulet'), [5, 37, 38, 40, 59, 60, 93]);
  assert.deepEqual(inCategory('poissons'), [7, 39, 64]);
  assert.deepEqual(inCategory('orientaux-maghrebins'), [41, 97, 98]);
});

// Produits des reçus Épilys (v0.7.11) : 32 nouveaux (ids 68-99), prix
// des reçus, aucun doublon de nom avec les 67 premiers.
test('les 32 produits des reçus sont présents, avec les prix des reçus', () => {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const expected = {
    68: { price_cents: 499, category: 'laitages-oeufs' },
    69: { price_cents: 399, category: 'epicerie-seche' },
    70: { price_cents: 1149, category: 'epicerie-seche' },
    71: { price_cents: 249, category: 'boissons', deposit_cents: 10 },
    72: { price_cents: 389, category: 'laitages-oeufs' },
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
    93: { price_cents: 1399, category: 'poulet', prepared: true },
    94: { price_cents: 49, category: 'boulangerie' },
    95: { price_cents: 99, category: 'legumes' },
    96: { price_cents: 149, category: 'epicerie-seche' },
    97: { price_cents: 399, category: 'orientaux-maghrebins', prepared: true },
    98: { price_cents: 299, category: 'orientaux-maghrebins', prepared: true },
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
