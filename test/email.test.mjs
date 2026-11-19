// Tests du reçu e-mail (v0.7.13) : le reçu montre le code à 6 chiffres,
// jamais l'id technique ni le numéro du jour (réservé à l'admin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReceiptEmail } from '../src/email.js';

const ORDER_EXEMPLE = {
  id: 8,
  delivery_code: '123456',
  daily_number: 6,
  mode: 'livraison',
  total_cents: 1395,
  final_total_cents: 1395,
  created_at: '2026-11-19T14:30:00.000Z',
  delivery_fee_cents: 299,
  service_fee_cents: 499,
  tip_cents: 0,
  deposit_cents: 0,
  tps_cents: 0,
  tvq_cents: 0,
  address: '5590 rue de Salaberry',
  postal_code: 'H4J 1J6',
  phone: '5146044419',
  note: '',
};

const ITEMS_EXEMPLE = [
  {
    product_name: 'Tomates',
    status: 'collecte',
    quantity: 1,
    weight_grams: 500,
    collected_weight_grams: 480,
    line_total_cents: 239,
  },
  {
    product_name: 'Baguette',
    status: 'manquant',
    quantity: 2,
    weight_grams: null,
    collected_weight_grams: null,
    line_total_cents: 0,
  },
];

test('le reçu montre le code, pas l’id ni le numéro du jour', () => {
  const mail = buildReceiptEmail({
    order: ORDER_EXEMPLE,
    items: ITEMS_EXEMPLE,
    customerName: 'riadovitch',
  });
  assert.equal(
    mail.subject,
    'Soukly — Reçu de votre commande (code 123456)',
  );
  for (const part of [mail.subject, mail.text, mail.html]) {
    assert.ok(part.includes('(code 123456)'), part);
    assert.ok(!part.includes('n° 8'), part);
    assert.ok(!part.includes('Commande 6/'), part);
  }
  assert.ok(mail.text.includes('Tomates'), mail.text);
  assert.ok(mail.text.includes('Total : 13,95 $'), mail.text);
});
