// Espace Livreur — troisième espace de l'appli (Admin, Client, Livreur).
// Comptes livreurs créés par l'admin (nom d'utilisateur + mot de passe,
// haché bcrypt — pas de vérification par e-mail, l'admin les crée).
// Le livreur voit ses livraisons, démarre la livraison (envoi de sa
// position GPS), et confirme la remise avec le code de remise à 4
// chiffres du client (v0.7.14 — le code à 6 chiffres est
// l'identifiant de commande, il ne confirme plus) — ou, si le client
// n'est pas là, en déposant la commande devant la porte et en prenant
// une photo comme preuve (v0.7.3). Le livreur ne reçoit JAMAIS le
// code à 4 chiffres dans ses charges utiles : le client le lui donne
// à la remise.
// Le jeton JWT porte `courier_id` (les jetons clients portent
// `customer_id`) : un jeton client ne passe pas `requireCourier`.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { all, get, run } from './db.js';
import { isValidHandoverCode, loadOrderWithItems } from './orders.js';
import { sendOrderReceipt } from './email.js';
import { photoUpload, photoUploadError } from './photos.js';
import {
  notifyDropoff,
  notifyOrderStatusChange,
} from './notifications.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = '30d';
const PASSWORD_MIN_LENGTH = 8;

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

const USERNAME_REGEX = /^[a-z0-9._-]{3,30}$/;

function publicCourier(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name || row.username,
    created_at: row.created_at,
  };
}

function signCourierToken(courier) {
  return jwt.sign(
    { courier_id: courier.id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export async function requireCourier(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.courier_id == null) {
      return res.status(401).json({ ok: false, error: 'auth_invalid' });
    }
    const courier = await get('SELECT * FROM couriers WHERE id = $1', payload.courier_id);
    if (!courier) {
      return res.status(401).json({ ok: false, error: 'auth_invalid' });
    }
    req.courier = courier;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'auth_invalid' });
  }
}

/// Charge une commande assignée à ce livreur (null si inexistante ou
/// assignée à un autre livreur — même erreur dans les deux cas, on ne
/// révèle pas les livraisons des autres).
async function loadAssignedOrder(orderId, courierId) {
  const order = await get('SELECT * FROM orders WHERE id = $1', orderId);
  if (!order || order.courier_id !== courierId) return null;
  return order;
}

export const courierRouter = Router();

// POST /api/courier/login — connexion livreur (nom d'utilisateur +
// mot de passe). Pas de code e-mail : les comptes sont créés par
// l'admin. Erreur générique dans tous les cas (on ne révèle jamais si
// c'est l'identifiant ou le mot de passe qui est faux).
courierRouter.post('/courier/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || '');
  const courier = await get(
    'SELECT * FROM couriers WHERE username = $1',
    username,
  );
  if (!courier || !bcrypt.compareSync(password, courier.password_hash)) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  return res.json({
    ok: true,
    token: signCourierToken(courier),
    courier: publicCourier(courier),
  });
});

courierRouter.get('/courier/me', requireCourier, (req, res) => {
  return res.json({ ok: true, courier: publicCourier(req.courier) });
});

// GET /api/courier/deliveries — livraisons assignées à ce livreur,
// en cours (pas terminées ni annulées). La cueillette sur place n'y
// figure pas : seules les livraisons ont un livreur.
courierRouter.get('/courier/deliveries', requireCourier, async (req, res) => {
  const rows = await all(
    `SELECT id FROM orders WHERE courier_id = $1
     AND status NOT IN ('terminee', 'annulee') ORDER BY id`,
    req.courier.id,
  );
  const orders = [];
  for (const row of rows) {
    orders.push(await loadOrderWithItems(row.id));
  }
  return res.json({ ok: true, orders });
});

// POST /api/courier/deliveries/{id}/start — démarrer la livraison :
// la commande passe en « en_livraison » (livreur en route) et
// l'envoi de la position GPS peut commencer. Départ autorisé depuis
// « en_preparation » ou « prete » (la collecte est faite ou en cours).
courierRouter.post('/courier/deliveries/:id/start', requireCourier, async (req, res) => {
  const id = Number(req.params.id);
  const order = await loadAssignedOrder(id, req.courier.id);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  if (order.mode !== 'livraison') {
    return res.status(409).json({ ok: false, error: 'not_a_delivery' });
  }
  if (order.status === 'en_livraison') {
    return res.json({ ok: true, order: await loadOrderWithItems(id) });
  }
  if (order.status !== 'en_preparation' && order.status !== 'prete') {
    return res.status(409).json({ ok: false, error: 'order_not_ready' });
  }
  await run(
    'UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3',
    'en_livraison', new Date().toISOString(), id,
  );
  const full = await loadOrderWithItems(id);
  // Livreur en route : le client est averti par notification push.
  notifyOrderStatusChange(full, 'en_livraison').catch((err) =>
    console.error('[fcm] notifyOrderStatusChange :', err.message),
  );
  return res.json({ ok: true, order: full });
});

// POST /api/courier/deliveries/{id}/position — envoyer sa position
// GPS (lat/lng) pendant une livraison en cours seulement. Une seule
// ligne par commande, mise à jour à chaque envoi : le client ne voit
// que la dernière position connue.
courierRouter.post('/courier/deliveries/:id/position', requireCourier, async (req, res) => {
  const id = Number(req.params.id);
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ ok: false, error: 'position_invalid' });
  }
  const order = await loadAssignedOrder(id, req.courier.id);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  if (order.status !== 'en_livraison') {
    return res.status(409).json({ ok: false, error: 'order_not_in_delivery' });
  }
  const now = new Date().toISOString();
  await run(
    `INSERT INTO courier_positions (order_id, courier_id, lat, lng, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id) DO UPDATE
     SET courier_id = EXCLUDED.courier_id, lat = EXCLUDED.lat,
         lng = EXCLUDED.lng, updated_at = EXCLUDED.updated_at`,
    id, req.courier.id, lat, lng, now,
  );
  return res.json({ ok: true, position: { lat, lng, updated_at: now } });
});

// Terminer une livraison : la commande passe en « terminee » (le
// total final est fixé), le partage de position s'arrête et le reçu
// part par e-mail (une seule fois). Commun à la confirmation par code
// et à la confirmation par photo de dépôt (v0.7.3).
// Notifications push : remise par code → le client (« Commande
// livrée ») ; dépôt avec photo → le client ET l'admin (v0.7.4).
async function finalizeDelivery(order, { viaDropoff = false } = {}) {
  const now = new Date().toISOString();
  const finalTotal = order.final_total_cents ?? order.total_cents;
  await run(
    'UPDATE orders SET status = $1, final_total_cents = $2, updated_at = $3 WHERE id = $4',
    'terminee', finalTotal, now, order.id,
  );
  await run('DELETE FROM courier_positions WHERE order_id = $1', order.id);
  if (!order.receipt_email_sent_at) {
    sendOrderReceipt(order.id).catch((err) => console.error('[receipt]', err.message));
  }
  const finished = await loadOrderWithItems(order.id);
  if (viaDropoff) {
    notifyDropoff(finished).catch((err) =>
      console.error('[fcm] notifyDropoff :', err.message),
    );
  } else {
    notifyOrderStatusChange(finished, 'terminee').catch((err) =>
      console.error('[fcm] notifyOrderStatusChange :', err.message),
    );
  }
  return finished;
}

// POST /api/courier/deliveries/{id}/confirm — confirmer la remise
// avec le code de remise à 4 chiffres du client (v0.7.14) : la
// commande passe en « terminee » (le reçu part par e-mail comme
// quand l'admin termine une commande) et le partage de position
// s'arrête (ligne supprimée). Le code à 6 chiffres est l'identifiant
// de commande : il ne confirme PLUS la remise (un code à 6 chiffres
// est refusé ici). Le livreur ne reçoit jamais le code à 4 chiffres
// dans ses charges utiles : c'est le client qui le lui donne à la
// remise, de vive voix.
courierRouter.post('/courier/deliveries/:id/confirm', requireCourier, async (req, res) => {
  const id = Number(req.params.id);
  const code = String(req.body?.handover_code || '').trim();
  if (!isValidHandoverCode(code)) {
    return res.status(400).json({ ok: false, error: 'handover_code_invalid' });
  }
  const order = await loadAssignedOrder(id, req.courier.id);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  if (order.status !== 'en_livraison') {
    return res.status(409).json({ ok: false, error: 'order_not_in_delivery' });
  }
  if (code !== order.handover_code) {
    return res.status(403).json({ ok: false, error: 'handover_code_invalid' });
  }
  const finished = await finalizeDelivery(order);
  return res.json({ ok: true, order: finished });
});

// POST /api/courier/deliveries/{id}/dropoff-photo — envoyer la photo
// de dépôt (multipart, champ `photo`, JPEG/PNG/WebP, 5 Mo max, même
// mécanisme que les photos produits). Livraison en cours seulement.
// La photo est enregistrée sur la commande (dropoff_photo_key) :
// elle sert de preuve si le client ne donne pas son code, et elle
// est visible par l'admin et par le client. L'envoi seul ne termine
// pas la livraison : il faut ensuite appeler /confirm-dropoff.
courierRouter.post('/courier/deliveries/:id/dropoff-photo', requireCourier, (req, res) => {
  photoUpload.single('photo')(req, res, async (err) => {
    if (err) {
      const { status, body } = photoUploadError(err);
      return res.status(status).json(body);
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'photo_required' });
    }
    const id = Number(req.params.id);
    const order = await loadAssignedOrder(id, req.courier.id);
    if (!order || order.status !== 'en_livraison') {
      // Photo déjà enregistrée sur le disque mais commande invalide :
      // on la supprime pour ne pas laisser de fichier orphelin.
      fs.unlink(req.file.path, () => {});
      if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
      return res.status(409).json({ ok: false, error: 'order_not_in_delivery' });
    }
    await run(
      'UPDATE orders SET dropoff_photo_key = $1, updated_at = $2 WHERE id = $3',
      req.file.filename, new Date().toISOString(), id,
    );
    return res.status(201).json({ ok: true, order: await loadOrderWithItems(id) });
  });
});

// POST /api/courier/deliveries/{id}/confirm-dropoff — confirmer la
// remise avec la photo de dépôt, sans le code du client. Quand le
// livreur arrive et que le client n'est pas là (ou ne donne pas son
// code), il dépose la commande devant la porte, prend une photo comme
// preuve et part tout de suite — aucune attente. Il faut une photo
// envoyée. La commande passe en « terminee » comme pour la
// confirmation par code (total final fixé, position arrêtée, reçu
// e-mail envoyé).
courierRouter.post('/courier/deliveries/:id/confirm-dropoff', requireCourier, async (req, res) => {
  const id = Number(req.params.id);
  const order = await loadAssignedOrder(id, req.courier.id);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  if (order.status !== 'en_livraison') {
    return res.status(409).json({ ok: false, error: 'order_not_in_delivery' });
  }
  if (!order.dropoff_photo_key) {
    return res.status(400).json({ ok: false, error: 'dropoff_photo_required' });
  }
  const finished = await finalizeDelivery(order, { viaDropoff: true });
  return res.json({ ok: true, order: finished });
});
