// Tests unitaires des notifications FCM (v0.7.4) — envoi simulé.
//
// L'envoi réel vers Google n'est jamais appelé ici : fetch est remplacé
// par un faux qui enregistre les appels. Les parties qui touchent la
// base (registre des jetons, déclencheurs) sont vérifiées en curl
// contre le serveur local (voir ~/workspace/verify-notifications.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildServiceAccountJwt,
  courierAssignedBody,
  deliveryCodeLabel,
  dropoffAdminBody,
  dropoffClientBody,
  fcmAccessToken,
  isValidNotificationSound,
  messageNotificationBody,
  messageNotificationTitle,
  newOrderBody,
  notificationSoundSettings,
  orderStatusBody,
  resetFcmStateForTests,
  sendFcmMessage,
  setFetchForTests,
} from '../src/notifications.js';

// Fausse clé de compte de service (paire RSA générée pour le test).
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const fakeServiceAccount = {
  project_id: 'soukly-test',
  client_email: 'test@soukly-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

function setFakeConfig() {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(
    fakeServiceAccount,
  );
}

function okJson(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function failJson(status, obj) {
  return {
    ok: false,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

/// Faux fetch : enregistre les appels et répond selon l'URL
/// (échange OAuth2 ou envoi FCM).
function mockFetch({ onTokenExchange, onFcmSend }) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes('oauth2.googleapis.com')) {
      return onTokenExchange(url, options);
    }
    return onFcmSend(url, options);
  };
  fn.calls = calls;
  return fn;
}

test('le JWT du compte de service est un RS256 signé valide', () => {
  const assertion = buildServiceAccountJwt(fakeServiceAccount);
  const [headerB64, claimsB64, signatureB64] = assertion.split('.');
  assert.equal(assertion.split('.').length, 3);
  const header = JSON.parse(
    Buffer.from(headerB64, 'base64url').toString('utf8'),
  );
  assert.equal(header.alg, 'RS256');
  const claims = JSON.parse(
    Buffer.from(claimsB64, 'base64url').toString('utf8'),
  );
  assert.equal(claims.iss, fakeServiceAccount.client_email);
  assert.equal(
    claims.scope,
    'https://www.googleapis.com/auth/firebase.messaging',
  );
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(claims.exp > claims.iat);
  // La signature se vérifie avec la clé publique.
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${claimsB64}`, 'utf8'),
    publicKey,
    Buffer.from(signatureB64, 'base64url'),
  );
  assert.equal(valid, true);
});

test("l'échange OAuth2 est fait une seule fois (jeton mis en cache)", async () => {
  resetFcmStateForTests();
  setFakeConfig();
  let exchanges = 0;
  const fetch = mockFetch({
    onTokenExchange: async () => {
      exchanges += 1;
      return okJson({ access_token: 'tok-123', expires_in: 3600 });
    },
    onFcmSend: async () => okJson({ name: 'projects/soukly-test/messages/1' }),
  });
  setFetchForTests(fetch);
  try {
    assert.equal(await fcmAccessToken(), 'tok-123');
    assert.equal(await fcmAccessToken(), 'tok-123');
    assert.equal(exchanges, 1);
    const exchange = fetch.calls.find((c) =>
      String(c.url).includes('oauth2.googleapis.com'),
    );
    assert.ok(exchange);
    assert.equal(
      exchange.options.headers['Content-Type'],
      'application/x-www-form-urlencoded',
    );
    assert.match(
      String(exchange.options.body),
      /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/,
    );
  } finally {
    resetFcmStateForTests();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

test("l'envoi FCM construit la bonne requête HTTP v1 (son par défaut)", async () => {
  resetFcmStateForTests();
  setFakeConfig();
  let fcmCall;
  const fetch = mockFetch({
    onTokenExchange: async () =>
      okJson({ access_token: 'tok-abc', expires_in: 3600 }),
    onFcmSend: async (url, options) => {
      fcmCall = { url, options };
      return okJson({ name: 'projects/soukly-test/messages/42' });
    },
  });
  setFetchForTests(fetch);
  try {
    const result = await sendFcmMessage({
      token: 'fcm-token-xyz',
      title: 'Nouvelle commande',
      body: 'Nouvelle commande (code 123456) — livraison, 13,95 $.',
      data: { type: 'order', order_id: '12', role: 'admin' },
    });
    assert.deepEqual(result, { sent: true });
    assert.equal(
      fcmCall.url,
      'https://fcm.googleapis.com/v1/projects/soukly-test/messages:send',
    );
    assert.equal(
      fcmCall.options.headers.Authorization,
      'Bearer tok-abc',
    );
    const payload = JSON.parse(fcmCall.options.body);
    assert.equal(payload.message.token, 'fcm-token-xyz');
    assert.equal(payload.message.notification.title, 'Nouvelle commande');
    assert.equal(
      payload.message.notification.body,
      'Nouvelle commande (code 123456) — livraison, 13,95 $.',
    );
    // Son par défaut du téléphone + canal « Commandes Soukly ».
    assert.equal(payload.message.android.notification.sound, 'default');
    assert.equal(
      payload.message.android.notification.channel_id,
      'soukly_commandes',
    );
    assert.deepEqual(payload.message.data, {
      type: 'order',
      order_id: '12',
      role: 'admin',
    });
  } finally {
    resetFcmStateForTests();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

test('sans configuration Firebase, l’envoi est ignoré sans lever', async () => {
  resetFcmStateForTests();
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const fetch = mockFetch({
    onTokenExchange: async () => {
      throw new Error('ne doit pas être appelé');
    },
    onFcmSend: async () => {
      throw new Error('ne doit pas être appelé');
    },
  });
  setFetchForTests(fetch);
  try {
    const result = await sendFcmMessage({
      token: 'fcm-token-xyz',
      title: 'Titre',
      body: 'Texte',
    });
    assert.deepEqual(result, { sent: false, reason: 'fcm_not_configured' });
    assert.equal(fetch.calls.length, 0);
  } finally {
    resetFcmStateForTests();
  }
});

test("un refus de FCM ne lève pas et n'empêche pas l'action", async () => {
  resetFcmStateForTests();
  setFakeConfig();
  const fetch = mockFetch({
    onTokenExchange: async () =>
      okJson({ access_token: 'tok-abc', expires_in: 3600 }),
    onFcmSend: async () =>
      failJson(404, { error: { message: 'token not found' } }),
  });
  setFetchForTests(fetch);
  try {
    const result = await sendFcmMessage({
      token: 'fcm-token-mort',
      title: 'Titre',
      body: 'Texte',
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'fcm_send_failed');
    assert.equal(result.status, 404);
  } finally {
    resetFcmStateForTests();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

test("un échange OAuth2 en échec ne lève pas côté envoi", async () => {
  resetFcmStateForTests();
  setFakeConfig();
  const fetch = mockFetch({
    onTokenExchange: async () =>
      failJson(400, { error: 'invalid_grant' }),
    onFcmSend: async () => {
      throw new Error('ne doit pas être appelé');
    },
  });
  setFetchForTests(fetch);
  try {
    const result = await sendFcmMessage({
      token: 'fcm-token-xyz',
      title: 'Titre',
      body: 'Texte',
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'fcm_send_failed');
  } finally {
    resetFcmStateForTests();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

// Son de notification (v0.7.10) : mapping canal + son FCM, et
// validation du champ `sound` de POST /api/notifications/token.

test('le mapping son → canal + son FCM est correct', () => {
  assert.deepEqual(notificationSoundSettings('default'), {
    channelId: 'soukly_commandes',
    fcmSound: 'default',
  });
  assert.deepEqual(notificationSoundSettings('long'), {
    channelId: 'soukly_commandes_long',
    fcmSound: 'soukly_long',
  });
  assert.deepEqual(notificationSoundSettings('alarme'), {
    channelId: 'soukly_commandes_alarme',
    fcmSound: 'soukly_alarme',
  });
});

test('un son inconnu ou absent retombe sur le son par défaut', () => {
  assert.deepEqual(notificationSoundSettings('bidon'), {
    channelId: 'soukly_commandes',
    fcmSound: 'default',
  });
  assert.deepEqual(notificationSoundSettings(undefined), {
    channelId: 'soukly_commandes',
    fcmSound: 'default',
  });
  assert.deepEqual(notificationSoundSettings(null), {
    channelId: 'soukly_commandes',
    fcmSound: 'default',
  });
});

test('la validation du son accepte les 3 choix et refuse le reste', () => {
  assert.equal(isValidNotificationSound('default'), true);
  assert.equal(isValidNotificationSound('long'), true);
  assert.equal(isValidNotificationSound('alarme'), true);
  assert.equal(isValidNotificationSound('bidon'), false);
  assert.equal(isValidNotificationSound(''), false);
  assert.equal(isValidNotificationSound(undefined), false);
  assert.equal(isValidNotificationSound('LONG'), false);
});

test("l'envoi FCM utilise le canal et le son du destinataire", async () => {
  resetFcmStateForTests();
  setFakeConfig();
  let fcmCall;
  const fetch = mockFetch({
    onTokenExchange: async () =>
      okJson({ access_token: 'tok-abc', expires_in: 3600 }),
    onFcmSend: async (url, options) => {
      fcmCall = { url, options };
      return okJson({ name: 'projects/soukly-test/messages/42' });
    },
  });
  setFetchForTests(fetch);
  try {
    const result = await sendFcmMessage({
      token: 'fcm-token-xyz',
      title: 'Nouvelle commande',
      body: 'Nouvelle commande (code 123456) — livraison, 13,95 $.',
      data: { type: 'order', order_id: '12', role: 'admin' },
      sound: 'long',
    });
    assert.deepEqual(result, { sent: true });
    const payload = JSON.parse(fcmCall.options.body);
    assert.equal(payload.message.android.notification.sound, 'soukly_long');
    assert.equal(
      payload.message.android.notification.channel_id,
      'soukly_commandes_long',
    );
  } finally {
    resetFcmStateForTests();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

test("l'envoi FCM avec un son inconnu retombe sur le défaut", async () => {
  resetFcmStateForTests();
  setFakeConfig();
  let fcmCall;
  const fetch = mockFetch({
    onTokenExchange: async () =>
      okJson({ access_token: 'tok-abc', expires_in: 3600 }),
    onFcmSend: async (url, options) => {
      fcmCall = { url, options };
      return okJson({ name: 'projects/soukly-test/messages/42' });
    },
  });
  setFetchForTests(fetch);
  try {
    const result = await sendFcmMessage({
      token: 'fcm-token-xyz',
      title: 'Titre',
      body: 'Texte',
      sound: 'bidon',
    });
    assert.deepEqual(result, { sent: true });
    const payload = JSON.parse(fcmCall.options.body);
    assert.equal(payload.message.android.notification.sound, 'default');
    assert.equal(
      payload.message.android.notification.channel_id,
      'soukly_commandes',
    );
  } finally {
    resetFcmStateForTests();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

// Textes de notification (v0.7.13) : le code à 6 chiffres est le seul
// identifiant de commande montré — jamais l'id technique ni le numéro
// du jour (le client et le livreur ne les voient plus).

const ORDER_EXEMPLE = {
  id: 8,
  delivery_code: '123456',
  daily_number: 6,
  mode: 'livraison',
  total_cents: 1395,
  address: '5590 rue de Salaberry',
  postal_code: 'H4J 1J6',
};

test('le libellé du code est ` (code 123456)` ou vide sans code', () => {
  assert.equal(deliveryCodeLabel(ORDER_EXEMPLE), ' (code 123456)');
  assert.equal(deliveryCodeLabel({ id: 8 }), '');
  assert.equal(deliveryCodeLabel({}), '');
  assert.equal(deliveryCodeLabel(null), '');
});

test('tous les textes de notification montrent le code, pas l’id', () => {
  const bodies = [
    newOrderBody(ORDER_EXEMPLE),
    courierAssignedBody(ORDER_EXEMPLE),
    orderStatusBody('en_preparation', ORDER_EXEMPLE),
    orderStatusBody('prete', ORDER_EXEMPLE),
    orderStatusBody('en_livraison', ORDER_EXEMPLE),
    orderStatusBody('terminee', ORDER_EXEMPLE),
    orderStatusBody('annulee', ORDER_EXEMPLE),
    dropoffClientBody(ORDER_EXEMPLE),
    dropoffAdminBody(ORDER_EXEMPLE),
  ];
  assert.equal(bodies.length, 9);
  for (const body of bodies) {
    assert.ok(body.includes('(code 123456)'), body);
    assert.ok(!body.includes('n°'), body);
    assert.ok(!body.includes('8'), body);
  }
  assert.equal(
    newOrderBody(ORDER_EXEMPLE),
    'Nouvelle commande (code 123456) — livraison, 13,95 $.',
  );
  assert.equal(
    courierAssignedBody(ORDER_EXEMPLE),
    'Commande à livrer (code 123456) — 5590 rue de Salaberry.',
  );
  assert.equal(
    orderStatusBody('en_livraison', ORDER_EXEMPLE),
    'Votre commande (code 123456) est en route.',
  );
});

test('sans code, les textes restent lisibles et sans numéro', () => {
  const sansCode = { id: 8, mode: 'cueillette', total_cents: 1000 };
  assert.equal(
    newOrderBody(sansCode),
    'Nouvelle commande — cueillette, 10,00 $.',
  );
  assert.equal(
    orderStatusBody('terminee', sansCode),
    'Votre commande est livrée. Merci !',
  );
  assert.equal(orderStatusBody('inexistant', ORDER_EXEMPLE), null);
});

// Messagerie (v0.7.14) : titre selon l'expéditeur, corps tronqué.
test('messageNotificationTitle : le client voit « Message du livreur »', () => {
  assert.equal(messageNotificationTitle('courier'), 'Message du livreur');
  assert.equal(messageNotificationTitle('client'), 'Message du client');
});

test('messageNotificationBody : message court intact, long tronqué à 120', () => {
  assert.equal(messageNotificationBody('Je suis en bas !'), 'Je suis en bas !');
  const long = 'x'.repeat(200);
  const body = messageNotificationBody(long);
  assert.equal(body.length, 120);
  assert.ok(body.endsWith('…'));
});
