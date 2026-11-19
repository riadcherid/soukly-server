// Notifications push — Firebase Cloud Messaging (FCM), API HTTP v1
// (v0.7.7).
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
import { requireAdmin } from './admin.js';
import { all, get, run } from './db.js';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Canal de notification Android (créé côté appli au démarrage) :
// importance haute + son par défaut.
const ANDROID_CHANNEL_ID = 'soukly_commandes';

// Son de notification (v0.7.10) : un canal Android ne peut pas
// changer de son une fois créé sur le téléphone — il faut donc un
// canal distinct par son, créé côté appli au démarrage. Le son est
// choisi dans l'appli (Réglages notifications), enregistré avec le
// jeton, et réutilisé ici à chaque envoi. Valeur inconnue ou absente
// → 'default'.
export const NOTIFICATION_SOUND_SETTINGS = {
  default: { channelId: ANDROID_CHANNEL_ID, fcmSound: 'default' },
  long: { channelId: 'soukly_commandes_long', fcmSound: 'soukly_long' },
  alarme: {
    channelId: 'soukly_commandes_alarme',
    fcmSound: 'soukly_alarme',
  },
};

/// Réglages FCM d'un son ('default' | 'long' | 'alarme') : canal
/// Android + nom du son à envoyer. Repli sur 'default' sinon.
export function notificationSoundSettings(sound) {
  return (
    NOTIFICATION_SOUND_SETTINGS[sound] || NOTIFICATION_SOUND_SETTINGS.default
  );
}

/// Vrai si le son est un des trois choix valides.
export function isValidNotificationSound(sound) {
  return Object.hasOwn(NOTIFICATION_SOUND_SETTINGS, sound);
}

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
/// `sound` : son choisi par le destinataire ('default' | 'long' |
/// 'alarme', v0.7.10) — canal + son FCM mappés, repli 'default'.
export async function sendFcmMessage({ token, title, body, data, sound }) {
  const sa = loadServiceAccount();
  if (!sa) return { sent: false, reason: 'fcm_not_configured' };
  try {
    const accessToken = await fcmAccessToken();
    if (!accessToken) return { sent: false, reason: 'fcm_not_configured' };
    const { channelId, fcmSound } = notificationSoundSettings(sound);
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
            // Son choisi par le destinataire + son canal dédié.
            android: {
              notification: {
                sound: fcmSound,
                channel_id: channelId,
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

async function sendToTokens(tokenRows, { title, body, data }) {
  if (!tokenRows || tokenRows.length === 0) {
    return { attempted: 0, sent: 0 };
  }
  const results = await Promise.allSettled(
    tokenRows.map((row) =>
      sendFcmMessage({
        token: row.token,
        title,
        body,
        data,
        sound: row.sound,
      }),
    ),
  );
  const sent = results.filter(
    (r) => r.status === 'fulfilled' && r.value.sent,
  ).length;
  return { attempted: tokenRows.length, sent };
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
/// `sound` (v0.7.10) : son choisi sur le téléphone ('default' |
/// 'long' | 'alarme') — une valeur inconnue retombe sur 'default'.
export async function registerDeviceToken(
  ownerType,
  ownerId,
  token,
  platform,
  sound = 'default',
) {
  const now = new Date().toISOString();
  const safeSound = isValidNotificationSound(sound) ? sound : 'default';
  await run(
    `INSERT INTO device_tokens
       (owner_type, owner_id, token, platform, sound, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (token, owner_type, owner_id) DO UPDATE SET
       platform = EXCLUDED.platform,
       sound = EXCLUDED.sound,
       updated_at = EXCLUDED.updated_at`,
    ownerType,
    ownerId,
    token,
    platform,
    safeSound,
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
    'SELECT token, sound FROM device_tokens WHERE owner_type = $1 AND owner_id = $2',
    ownerType,
    ownerId,
  );
  return rows;
}

async function tokensForAdmins() {
  const rows = await all(
    "SELECT token, sound FROM device_tokens WHERE owner_type = 'admin'",
  );
  return rows;
}

/// Liste les jetons enregistrés (diagnostic admin, v0.7.7) : le
/// jeton complet n'est JAMAIS renvoyé, seulement ses 8 premiers
/// caractères (préfixe) pour reconnaître un appareil.
export async function listDeviceTokens() {
  const rows = await all(
    `SELECT owner_type, owner_id, platform, sound, created_at, updated_at,
            SUBSTRING(token, 1, 8) AS token_prefix
       FROM device_tokens
      ORDER BY updated_at DESC`,
  );
  return rows;
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

/// Libellé du code de livraison à afficher dans un texte :
/// ` (code 123456)` — ou '' si le code est absent (ne doit pas
/// arriver : colonne NOT NULL depuis v0.6.1, remplie à la création).
/// Seul identifiant montré au client et au livreur (v0.7.13) : ni
/// l'id technique ni le numéro du jour ne sortent plus des textes
/// de notification.
export function deliveryCodeLabel(order) {
  const code = String(order?.delivery_code || '').trim();
  return code ? ` (code ${code})` : '';
}

/// Texte « Nouvelle commande » (admin) : le code suffit aussi à
/// l'admin (le numéro du jour est dans l'appli et le rapport).
export function newOrderBody(order) {
  const modeLabel = order.mode === 'livraison' ? 'livraison' : 'cueillette';
  return `Nouvelle commande${deliveryCodeLabel(order)} — ${modeLabel}, ${formatMoney(order.total_cents ?? 0)}.`;
}

/// Texte « Nouvelle livraison » (livreur).
export function courierAssignedBody(order) {
  const place = order.address || order.postal_code || '';
  return `Commande à livrer${deliveryCodeLabel(order)}${place ? ` — ${place}` : ''}.`;
}

/// Texte de changement de statut (client), ou null si le statut
/// n'a pas de message.
export function orderStatusBody(status, order) {
  const msg = STATUS_MESSAGES[status];
  if (!msg) return null;
  return msg.body(deliveryCodeLabel(order));
}

/// Texte « Commande déposée » (client).
export function dropoffClientBody(order) {
  return `Le livreur a déposé votre commande${deliveryCodeLabel(order)} devant votre porte (photo dans Mes commandes).`;
}

/// Texte « Dépôt avec photo » (admin).
export function dropoffAdminBody(order) {
  return `Commande${deliveryCodeLabel(order)} déposée devant la porte du client (photo).`;
}

/// Nouvelle commande → tous les jetons admin (« Nouvelle commande »).
export async function notifyNewOrder(order) {
  return notifyAdmins({
    title: 'Nouvelle commande',
    body: newOrderBody(order),
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
  return notifyCourier(order.courier_id, {
    title: 'Nouvelle livraison',
    body: courierAssignedBody(order),
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
    body: (label) => `Votre commande${label} est en cours de préparation.`,
  },
  prete: {
    title: 'Commande prête',
    body: (label) => `Votre commande${label} est prête, elle part bientôt.`,
  },
  en_livraison: {
    title: 'Livreur en route',
    body: (label) => `Votre commande${label} est en route.`,
  },
  terminee: {
    title: 'Commande livrée',
    body: (label) => `Votre commande${label} est livrée. Merci !`,
  },
  annulee: {
    title: 'Commande annulée',
    body: (label) => `Votre commande${label} a été annulée.`,
  },
};

/// Changement de statut → le client (en préparation, prête, en
/// livraison, terminée, annulée).
export async function notifyOrderStatusChange(order, status) {
  const msg = STATUS_MESSAGES[status];
  if (!msg || order.customer_id == null) return { attempted: 0, sent: 0 };
  return notifyCustomer(order.customer_id, {
    title: msg.title,
    body: orderStatusBody(status, order),
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
      body: dropoffClientBody(order),
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
    body: dropoffAdminBody(order),
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
// Corps : { token, platform, sound } (platform : 'android' | 'ios',
// défaut 'android' ; sound : 'default' | 'long' | 'alarme', défaut
// 'default' — v0.7.10). Un même jeton peut être enregistré pour
// plusieurs destinataires (un téléphone = un jeton par rôle).
notificationsRouter.post(
  '/notifications/token',
  requireAnyAuth,
  async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const platform = String(req.body?.platform || 'android')
      .trim()
      .toLowerCase();
    const sound = String(req.body?.sound || 'default').trim().toLowerCase();
    if (!token || token.length > 4096) {
      return res.status(400).json({ ok: false, error: 'token_invalid' });
    }
    if (platform !== 'android' && platform !== 'ios') {
      return res.status(400).json({ ok: false, error: 'platform_invalid' });
    }
    if (!isValidNotificationSound(sound)) {
      return res.status(400).json({ ok: false, error: 'sound_invalid' });
    }
    const { type, id } = req.notifyOwner;
    await registerDeviceToken(type, id, token, platform, sound);
    // Journalisé sans le jeton (v0.7.7 — diagnostic des pannes
    // « aucun jeton enregistré »).
    console.log(`[fcm] jeton enregistré (${type} ${id ?? 'admin'})`);
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
    console.log(`[fcm] jeton retiré (${type} ${id ?? 'admin'})`);
    return res.json({ ok: true });
  },
);

// GET /api/admin/device-tokens — liste des jetons enregistrés
// (diagnostic admin, v0.7.7) : destinataire, plateforme, dates et
// préfixe du jeton — jamais le jeton complet.
notificationsRouter.get(
  '/admin/device-tokens',
  requireAdmin,
  async (req, res) => {
    const tokens = await listDeviceTokens();
    return res.json({ ok: true, tokens });
  },
);
