// Tests de la forme du catalogue public (v0.7.19) — le champ
// `tax_exempt` est exposé dans GET /api/catalog pour que le site web
// (qui calcule les taxes localement) détaxe le café comme le serveur.
//
// Teste `toProduct` directement (pur, sans base) : la forme du
// produit public ne doit rien perdre des champs existants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toProduct } from '../src/catalog.js';

const baseRow = {
  id: 1,
  name: 'Produit test',
  description: 'desc',
  category_key: 'boissons',
  unit: 'la pièce',
  price_cents: 249,
  price_unit: 'piece',
  sold_by_weight: false,
  on_special: false,
  prepared: false,
  tax_exempt: false,
  deposit_cents: 0,
  available: true,
  image_key: null,
};

test('toProduct expose tax_exempt = true pour le café', () => {
  const p = toProduct({ ...baseRow, id: 19, name: 'Café en grains', tax_exempt: true });
  assert.equal(p.tax_exempt, true);
  const p2 = toProduct({ ...baseRow, id: 79, name: 'Café moulu 1001', tax_exempt: true });
  assert.equal(p2.tax_exempt, true);
});

test('toProduct expose tax_exempt = false quand le produit est taxé', () => {
  // Jus Ifruit : taxé (TPS + TVQ).
  const p = toProduct({ ...baseRow, id: 71, name: "Jus d'orange et pêche Ifruit", tax_exempt: false });
  assert.equal(p.tax_exempt, false);
  // Colonne absente (ancienne ligne) : false, pas undefined.
  const { tax_exempt, ...rowSansChamp } = baseRow;
  assert.equal(toProduct(rowSansChamp).tax_exempt, false);
});

test('toProduct garde tous les autres champs du produit public', () => {
  const p = toProduct({ ...baseRow, id: 71, on_special: true, deposit_cents: 10, prepared: false });
  assert.equal(p.id, 71);
  assert.equal(p.category, 'boissons');
  assert.equal(p.price_cents, 249);
  assert.equal(p.price_unit, 'piece');
  assert.equal(p.sold_by_weight, false);
  assert.equal(p.on_special, true);
  assert.equal(p.prepared, false);
  assert.equal(p.deposit_cents, 10);
  assert.equal(p.available, true);
  assert.equal(p.image_key, null);
  assert.equal(p.photo_url, null);
});
