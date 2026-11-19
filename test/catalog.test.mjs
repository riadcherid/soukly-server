// Tests du catalogue (v0.7.8) — refonte des rayons.
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

test('le catalogue a 22 rayons et 67 produits', () => {
  assert.equal(catalog.categories.length, 22);
  assert.equal(catalog.products.length, 67);
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
  assert.deepEqual(inCategory('poulet'), [5, 37, 38, 40, 59, 60]);
  assert.deepEqual(inCategory('poissons'), [7, 39, 64]);
  assert.deepEqual(inCategory('orientaux-maghrebins'), [41]);
});
