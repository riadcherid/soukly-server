// Tests de la messagerie par commande (v0.7.14) — parties pures.
// Les droits d'accès (autre client, livreur non assigné) et
// l'envoi/réception sont vérifiés en curl contre le serveur local
// (voir ~/workspace/verify-messages.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidHandoverCode } from '../src/orders.js';
import { validateMessageBody } from '../src/messages.js';

test('isValidHandoverCode : 4 chiffres exactement', () => {
  assert.equal(isValidHandoverCode('4829'), true);
  assert.equal(isValidHandoverCode('0000'), true);
  assert.equal(isValidHandoverCode('123'), false);
  assert.equal(isValidHandoverCode('12345'), false);
  assert.equal(isValidHandoverCode('123456'), false);
  assert.equal(isValidHandoverCode('abcd'), false);
  assert.equal(isValidHandoverCode(''), false);
  assert.equal(isValidHandoverCode(null), false);
});

test('validateMessageBody : vide refusé, trop long refusé, le reste accepté', () => {
  assert.deepEqual(validateMessageBody(''), { ok: false, error: 'message_required' });
  assert.deepEqual(validateMessageBody('   '), { ok: false, error: 'message_required' });
  assert.deepEqual(validateMessageBody(null), { ok: false, error: 'message_required' });
  assert.deepEqual(validateMessageBody('x'.repeat(1001)), { ok: false, error: 'message_too_long' });
  assert.deepEqual(validateMessageBody('  Je suis en bas !  '), {
    ok: true,
    body: 'Je suis en bas !',
  });
});
