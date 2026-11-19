// Messagerie dans l'appli, par commande (v0.7.14).
//
// Décision de Riad (2026-11-19) : « sms par l'application pas par
// téléphone » — le client et le livreur assigné échangent des
// messages DANS l'appli, liés à la commande (pas de chat global) ;
// l'admin peut les lire. Le bouton « Appeler » (tel:) reste tel quel.
//
// Routes (montées sous /api) :
// - POST /api/orders/:id/messages — client, sur ses propres commandes.
// - POST /api/courier/deliveries/:id/messages — livreur, sur ses
//   livraisons assignées uniquement.
// - GET /api/orders/:id/messages — client de la commande, livreur
//   assigné ou admin (requireAnyAuth : jeton client, livreur ou
//   admin). Un autre client ou un livreur non assigné → 404 (on ne
//   révèle pas l'existence de la commande).
//
// À chaque message, une notification push part au destinataire
// (« Message du livreur » / « Message du client », data
// {type:'message', order_id}) via le système FCM existant — jamais
// bloquante. Un message du client sans livreur assigné n'a pas de
// destinataire livreur : il est enregistré (l'admin peut le lire,
// le livreur le verra quand il sera assigné).
import { Router } from 'express';
import { all, get, run } from './db.js';
import { requireAuth } from './auth.js';
import { requireCourier } from './courier.js';
import {
  notifyOrderMessage,
  requireAnyAuth,
} from './notifications.js';

const MESSAGE_MAX_LENGTH = 1000;

/// Message sérialisé (jamais de donnée sensible : le corps seul).
function publicMessage(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    sender_type: row.sender_type,
    sender_id: row.sender_id,
    body: row.body,
    created_at: row.created_at,
  };
}

/// Valide le corps d'un message : { ok: true, body } ou
/// { ok: false, error: 'message_required' | 'message_too_long' }.
export function validateMessageBody(value) {
  const body = String(value ?? '').trim();
  if (!body) return { ok: false, error: 'message_required' };
  if (body.length > MESSAGE_MAX_LENGTH) {
    return { ok: false, error: 'message_too_long' };
  }
  return { ok: true, body };
}

async function insertMessage(orderId, senderType, senderId, body) {
  const now = new Date().toISOString();
  const result = await run(
    `INSERT INTO order_messages (order_id, sender_type, sender_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    orderId, senderType, senderId, body, now,
  );
  return result.rows[0];
}

export const messagesRouter = Router();

// POST /api/orders/:id/messages — le client écrit au livreur de SA
// commande (en cours : ni terminée ni annulée).
messagesRouter.post('/orders/:id/messages', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const order = await get('SELECT * FROM orders WHERE id = $1', id);
  if (!order || order.customer_id !== req.customer.id) {
    return res.status(404).json({ ok: false, error: 'order_not_found' });
  }
  if (order.status === 'terminee' || order.status === 'annulee') {
    return res.status(409).json({ ok: false, error: 'order_closed' });
  }
  const checked = validateMessageBody(req.body?.body);
  if (!checked.ok) {
    return res.status(400).json({ ok: false, error: checked.error });
  }
  const message = await insertMessage(id, 'client', req.customer.id, checked.body);
  // Notification au livreur assigné (s'il y en a un) — jamais bloquante.
  notifyOrderMessage(order, 'client', checked.body).catch((err) =>
    console.error('[fcm] notifyOrderMessage :', err.message),
  );
  return res.status(201).json({ ok: true, message: publicMessage(message) });
});

// POST /api/courier/deliveries/:id/messages — le livreur écrit au
// client de SA livraison assignée (en cours).
messagesRouter.post(
  '/courier/deliveries/:id/messages',
  requireCourier,
  async (req, res) => {
    const id = Number(req.params.id);
    const order = await get('SELECT * FROM orders WHERE id = $1', id);
    if (!order || order.courier_id !== req.courier.id) {
      return res.status(404).json({ ok: false, error: 'order_not_found' });
    }
    if (order.status === 'terminee' || order.status === 'annulee') {
      return res.status(409).json({ ok: false, error: 'order_closed' });
    }
    const checked = validateMessageBody(req.body?.body);
    if (!checked.ok) {
      return res.status(400).json({ ok: false, error: checked.error });
    }
    const message = await insertMessage(id, 'courier', req.courier.id, checked.body);
    // Notification au client — jamais bloquante.
    notifyOrderMessage(order, 'courier', checked.body).catch((err) =>
      console.error('[fcm] notifyOrderMessage :', err.message),
    );
    return res.status(201).json({ ok: true, message: publicMessage(message) });
  },
);

// GET /api/orders/:id/messages — les messages d'une commande, pour
// le client de la commande, le livreur assigné ou l'admin. Les
// autres (autre client, livreur non assigné) → 404.
messagesRouter.get('/orders/:id/messages', requireAnyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const order = await get('SELECT * FROM orders WHERE id = $1', id);
  if (!order) {
    return res.status(404).json({ ok: false, error: 'order_not_found' });
  }
  const party = req.notifyOwner;
  if (party.type === 'client' && order.customer_id !== party.id) {
    return res.status(404).json({ ok: false, error: 'order_not_found' });
  }
  if (party.type === 'courier' && order.courier_id !== party.id) {
    return res.status(404).json({ ok: false, error: 'order_not_found' });
  }
  const rows = await all(
    'SELECT * FROM order_messages WHERE order_id = $1 ORDER BY id',
    id,
  );
  return res.json({ ok: true, messages: rows.map(publicMessage) });
});
