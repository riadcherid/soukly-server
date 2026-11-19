// Notifications push — Firebase Cloud Messaging (FCM), API HTTP v1
// (v0.7.4).
//
// Le serveur envoie les notifications, l'appli les reçoit (avec son)
// quand elle est ouverte, en arrière-plan ou fermée. L'envoi ne doit
// JAMAIS faire échouer l'action principale (créer une commande,
// changer un statut...) : chaque fonction de notification attrape ses
// erreurs et journalise seulement.
//
// Configuration : la clé du compte de service Firebase est lue dans
// la variable d'environnement FIREBASE_SERVICE_ACCOUNT_JSON (le JSON
// complet, en une ligne — jamais en dur, jamais dans le dépôt).
// Sans elle, les notifications sont désactivées et les déclencheurs
// renvoient { sent: false, reason: 'fcm_not_configured' }.
// Voir server/NOTIFICATIONS_FIREBASE.md pour la créer.
//
// Échange du jeton d'accès : JWT RS256 signé avec la clé privée du
// compte de service, échangé contre un access_token OAuth2
// (valable 1 h, mis en cache jusqu'à 5 min avant expiration).
// Aucune dépendance npm ajoutée : fetch natif + node:crypto.
import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { all, get, run } from './db.js';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Canal de notification Android (créé côté appli au démarrage) :
// importance haute + son par défaut.
const ANDROID_CHANNEL_ID = 'soukly_commandes';

// ---------------------------------------------------------------------------
// État (compte de service, jeton d'accès, fetch injectable pour les tests)
// ---------------------------------------------------------------------------

let serviceAccountCache; // undefined = pas encore lu
let serviceAccountWarned = false;
let cachedAccessToken = null; // { token, expiresAtMs }
let fetchImpl = fetch;

/// Remplace fetch (tests uniquement).
export function setFetchForTests(fn) {
  fetchImpl = fn;
}

/// Réinitialise l'état FCM (tests uniquement) : compte de service,
/// jeton d'accès en cache et fetch.
export function resetFcmStateForTests() {
  serviceAccountCache = undefined;
  serviceAccountWarned = false;
  cachedAccessToken = null;
  fetchImpl = fetch;
}

function loadServiceAccount() {
  if (serviceAccountCache !== undefined) return serviceAccountCache;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  if (!raw) {
    if (!serviceAccountWarned) {
      console.warn(
        '[fcm] FIREBASE_SERVICE_ACCOUNT_JSON non défini — notifications push désactivées.',
      );
      serviceAccountWarned = true;
    }
    serviceAccountCache = null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('project_id, client_email ou private_key manquant');
    }
    serviceAccountCache = parsed;
    return parsed;
  } catch (err) {
    if (!serviceAccountWarned) {
      console.error(
        '[fcm] FIREBASE_SERVICE_ACCOUNT_JSON invalide :',
        err.message,
      );
      serviceAccountWarned = true;
    }
    serviceAccountCache = null;
    return null;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/// JWT signé RS256 pour l'échange OAuth2 (compte de service).
export function buildServiceAccountJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(unsigned, 'utf8'),
    serviceAccount.private_key,
  );
  return `${unsigned}.${signature.toString('base64url')}`;
}

/// Jeton d'accès OAuth2 (mis en cache jusqu'à 5 min avant expiration).
/// null si FCM n'est pas configuré.
export async function fcmAccessToken() {
  const sa = loadServiceAccount();
  if (!sa) return null;
  const now = Date.now();
  if (
    cachedAccessToken &&
    cachedAccessToken.expiresAtMs > now + 5 * 60 * 1000
  ) {
    return cachedAccessToken.token;
  }
  const assertion = buildServiceAccountJwt(sa);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `fcm_token_exchange_failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const json = await res.json();
  cachedAccessToken = {
    token: json.access_token,
    expiresAtMs: now + (json.expires_in || 3600) * 1000,
  };
  return cachedAccessToken.token;
}

// ---------------------------------------------------------------------------
// Envoi FCM
// ---------------------------------------------------------------------------

/// Envoie UN message FCM (API HTTP v1). Ne lève jamais : renvoie
/// { sent: true } ou { sent: false, reason }.
/// `data` : charge utile lue par l'appli au tap (type, order_id, role).
export async function sendFcmMessage({ token, title, body, data }) {
  const sa = loadServiceAccount();
  if (!sa) return { sent: false, reason: 'fcm_not_configured' };
  try {
    const accessToken = await fcmAccessToken();
    if (!accessToken) return { sent: false, reason: 'fcm_not_configured' };
    const res = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            // Son par défaut du téléphone + canal « Commandes Soukly ».
            android: {
              notification: {
                sound: 'default',
                channel_id: ANDROID_CHANNEL_ID,
              },
            },
            data: data || {},
          },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[fcm] envoi refusé', res.status, text.slice(0, 200));
      return { sent: false, reason: 'fcm_send_failed', status: res.status };
    }
    return { sent: true };
  } catch (err) {
    console.error('[fcm] erreur d’envoi :', err.message);
    return { sent: false, reason: 'fcm_send_failed', error: err.message };
  }
}

async function sendToTokens(tokens, { title, body, data }) {
  if (!tokens || tokens.length === 0) return { attempted: 0, sent: 0 };
  const results = await Promise.allSettled(
    tokens.map((token) => sendFcmMessage({ token, title, body, data })),
  );
  const sent = results.filter(
    (r) => r.status === 'fulfilled' && r.value.sent,
  ).length;
  return { attempted: tokens.length, sent };
}

// ---------------------------------------------------------------------------
// Registre des jetons d'appareil
// ---------------------------------------------------------------------------

/// Enregistre un jeton FCM pour un destinataire.
/// Un même jeton peut appartenir à plusieurs destinataires à la fois
/// (v0.7.5) : un téléphone utilisé comme client ET comme admin reçoit
/// les notifications des deux rôles (une ligne par destinataire).
/// `ownerType` : 'client' | 'courier' | 'admin' ; l'admin n'a pas
/// d'identifiant (ownerId null).
export async function registerDeviceToken(
  ownerType,
  ownerId,
  token,
  platform,
) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO device_tokens
       (owner_type, owner_id, token, platform, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (token, owner_type, owner_id) DO UPDATE SET
       platform = EXCLUDED.platform,
       updated_at = EXCLUDED.updated_at`,
    ownerType,
    ownerId,
    token,
    platform,
    now,
  );
}

/// Supprime le jeton d'UN destinataire (déconnexion). Les autres
/// rôles du même téléphone gardent leur jeton. Silencieux si absent.
export async function deleteDeviceToken(token, ownerType, ownerId) {
  await run(
    `DELETE FROM device_tokens
      WHERE token = $1 AND owner_type = $2
        AND owner_id IS NOT DISTINCT FROM $3`,
    token,
    ownerType,
    ownerId,
  );
}

async function tokensForOwner(ownerType, ownerId) {
  const rows = await all(
    'SELECT token FROM device_tokens WHERE owner_type = $1 AND owner_id = $2',
    ownerType,
    ownerId,
  );
  return rows.map((r) => r.token);
}

async function tokensForAdmins() {
  const rows = await all(
    "SELECT token FROM device_tokens WHERE owner_type = 'admin'",
  );
  return rows.map((r) => r.token);
}

// ---------------------------------------------------------------------------
// Notifications par destinataire (ne lèvent jamais)
// ---------------------------------------------------------------------------

export async function notifyCustomer(customerId, { title, body, data }) {
  try {
    const tokens = await tokensForOwner('client', customerId);
    if (tokens.length === 0) {
      console.log('[fcm] aucun jeton client pour', customerId);
    }
    return await sendToTokens(tokens, { title, body, data });
  } catch (err) {
    console.error('[fcm] notifyCustomer :', err.message);
    return { attempted: 0, sent: 0 };
  }
}

export async function notifyCourier(courierId, { title, body, data }) {
  try {
    const tokens = await tokensForOwner('courier', courierId);
    if (tokens.length === 0) {
      console.log('[fcm] aucun jeton livreur pour', courierId);
    }
    return await sendToTokens(tokens, { title, body, data });
  } catch (err) {
    console.error('[fcm] notifyCourier :', err.message);
    return { attempted: 0, sent: 0 };
  }
}

export async function notifyAdmins({ title, body, data }) {
  try {
    const tokens = await tokensForAdmins();
    if (tokens.length === 0) {
      console.log('[fcm] aucun jeton admin enregistré');
    }
    return await sendToTokens(tokens, { title, body, data });
  } catch (err) {
    console.error('[fcm] notifyAdmins :', err.message);
    return { attempted: 0, sent: 0 };
  }
}

// ---------------------------------------------------------------------------
// Déclencheurs (textes en français)
// ---------------------------------------------------------------------------

function formatMoney(cents) {
  return `${(cents / 100).toFixed(2).replace('.', ',')} $`;
}

/// Nouvelle commande → tous les jetons admin (« Nouvelle commande »).
export async function notifyNewOrder(order) {
  const modeLabel = order.mode === 'livraison' ? 'livraison' : 'cueillette';
  return notifyAdmins({
    title: 'Nouvelle commande',
    body: `Nouvelle commande n° ${order.id} — ${modeLabel}, ${formatMoney(
      order.total_cents ?? 0,
    )}.`,
    data: {
      type: 'order',
      order_id: String(order.id),
      role: 'admin',
    },
  });
}

/// Commande assignée → le livreur.
export async function notifyCourierAssigned(order) {
  if (order.courier_id == null) return { attempted: 0, sent: 0 };
  const place = order.address || order.postal_code || '';
  return notifyCourier(order.courier_id, {
    title: 'Nouvelle livraison',
    body: `Commande n° ${order.id} à livrer${place ? ` — ${place}` : ''}.`,
    data: {
      type: 'order',
      order_id: String(order.id),
      role: 'courier',
    },
  });
}

const STATUS_MESSAGES = {
  en_preparation: {
    title: 'Commande en préparation',
    body: (id) => `Votre commande n° ${id} est en cours de préparation.`,
  },
  prete: {
    title: 'Commande prête',
    body: (id) => `Votre commande n° ${id} est prête, elle part bientôt.`,
  },
  en_livraison: {
    title: 'Livreur en route',
    body: (id) => `Votre commande n° ${id} est en route.`,
  },
  terminee: {
    title: 'Commande livrée',
    body: (id) => `Votre commande n° ${id} est livrée. Merci !`,
  },
  annulee: {
    title: 'Commande annulée',
    body: (id) => `Votre commande n° ${id} a été annulée.`,
  },
};

/// Changement de statut → le client (en préparation, prête, en
/// livraison, terminée, annulée).
export async function notifyOrderStatusChange(order, status) {
  const msg = STATUS_MESSAGES[status];
  if (!msg || order.customer_id == null) return { attempted: 0, sent: 0 };
  return notifyCustomer(order.customer_id, {
    title: msg.title,
    body: msg.body(order.id),
    data: {
      type: 'order',
      order_id: String(order.id),
      role: 'client',
    },
  });
}

/// Photo de dépôt → le client ET l'admin (le livreur a déposé la
/// commande devant la porte, la photo est la preuve).
export async function notifyDropoff(order) {
  const results = { attempted: 0, sent: 0 };
  if (order.customer_id != null) {
    const r = await notifyCustomer(order.customer_id, {
      title: 'Commande déposée',
      body: `Le livreur a déposé votre commande n° ${order.id} devant votre porte (photo dans Mes commandes).`,
      data: {
        type: 'order',
        order_id: String(order.id),
        role: 'client',
      },
    });
    results.attempted += r.attempted;
    results.sent += r.sent;
  }
  const a = await notifyAdmins({
    title: 'Dépôt avec photo',
    body: `Commande n° ${order.id} déposée devant la porte du client (photo).`,
    data: {
      type: 'order',
      order_id: String(order.id),
      role: 'admin',
    },
  });
  results.attempted += a.attempted;
  results.sent += a.sent;
  return results;
}

// ---------------------------------------------------------------------------
// Authentification (client OU livreur OU admin) pour les routes jeton
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/// Accepte le jeton client (JWT customer_id), le jeton livreur (JWT
/// courier_id) ou le jeton admin (ADMIN_TOKEN). Remplit
/// req.notifyOwner = { type: 'client'|'courier'|'admin', id }.
export async function requireAnyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }
  // 1. Jeton admin (pas un JWT).
  if (ADMIN_TOKEN && safeEqual(token, ADMIN_TOKEN)) {
    req.notifyOwner = { type: 'admin', id: null };
    return next();
  }
  // 2. JWT client ou livreur (même secret que auth.js / courier.js).
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.customer_id != null) {
      const customer = await get(
        'SELECT id FROM customers WHERE id = $1',
        payload.customer_id,
      );
      if (!customer) {
        return res.status(401).json({ ok: false, error: 'auth_invalid' });
      }
      req.notifyOwner = { type: 'client', id: customer.id };
      return next();
    }
    if (payload.courier_id != null) {
      const courier = await get(
        'SELECT id FROM couriers WHERE id = $1',
        payload.courier_id,
      );
      if (!courier) {
        return res.status(401).json({ ok: false, error: 'auth_invalid' });
      }
      req.notifyOwner = { type: 'courier', id: courier.id };
      return next();
    }
  } catch {
    // Pas un JWT valide : 401 ci-dessous.
  }
  return res.status(401).json({ ok: false, error: 'auth_invalid' });
}

export const notificationsRouter = Router();

// POST /api/notifications/token — enregistrer le jeton FCM de cet
// appareil (client, livreur ou admin selon le jeton d'authentification).
// Corps : { token, platform } (platform : 'android' | 'ios', défaut
// 'android'). Un même jeton peut être enregistré pour plusieurs
// destinataires (un téléphone = un jeton par rôle).
notificationsRouter.post(
  '/notifications/token',
  requireAnyAuth,
  async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const platform = String(req.body?.platform || 'android')
      .trim()
      .toLowerCase();
    if (!token || token.length > 4096) {
      return res.status(400).json({ ok: false, error: 'token_invalid' });
    }
    if (platform !== 'android' && platform !== 'ios') {
      return res.status(400).json({ ok: false, error: 'platform_invalid' });
    }
    const { type, id } = req.notifyOwner;
    await registerDeviceToken(type, id, token, platform);
    return res.json({ ok: true });
  },
);

// DELETE /api/notifications/token — retirer le jeton FCM de CE
// destinataire (déconnexion). Les autres rôles du même téléphone
// gardent leur jeton. Corps : { token }. Silencieux si absent.
notificationsRouter.delete(
  '/notifications/token',
  requireAnyAuth,
  async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ ok: false, error: 'token_invalid' });
    }
    const { type, id } = req.notifyOwner;
    await deleteDeviceToken(token, type, id);
    return res.json({ ok: true });
  },
);
