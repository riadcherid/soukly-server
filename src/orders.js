// Commandes — miroir des actions `createorder`, `listmyorders`,
// `listorders`, `setorderstatus`, `setorderitemstatus`,
// `setorderitemweight` de l'appli web.
// Prix en cents, poids en grammes. Le total estimé est calculé à la
// commande ; le total final est fixé par la pesée réelle à la collecte.
import { Router } from 'express';
import { all, get, run, transaction } from './db.js';
import { requireAuth } from './auth.js';
import { requireAdmin } from './admin.js';
import { quoteFees } from './fees.js';

const ORDER_STATUSES = ['recue', 'en_preparation', 'prete', 'terminee', 'annulee'];
const ITEM_STATUSES = ['a_collecter', 'collecte', 'manquant'];

const WEIGHT_MIN_G = 1;
const WEIGHT_MAX_G = 5000; // poids choisi par le client (1 g à 5000 g)
const COLLECTED_MAX_G = 10000; // poids réel pesé : borne de sécurité large

function publicItem(row) {
  return {
    id: row.id,
    product_id: row.product_id,
    product_name: row.product_name,
    quantity: row.quantity,
    weight_grams: row.weight_grams,
    unit_price_cents: row.unit_price_cents,
    line_total_cents: row.line_total_cents,
    status: row.status,
    collected_weight_grams: row.collected_weight_grams,
    replacement_product_id: row.replacement_product_id,
  };
}

function publicOrder(row, items) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    mode: row.mode,
    status: row.status,
    address: row.address,
    postal_code: row.postal_code,
    phone: row.phone,
    note: row.note,
    delivery_fee_cents: row.delivery_fee_cents,
    service_fee_cents: row.service_fee_cents,
    tip_cents: row.tip_cents,
    estimated_total_cents: row.estimated_total_cents,
    total_cents: row.total_cents,
    final_total_cents: row.final_total_cents,
    delivery_zone: row.delivery_zone,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: (items || []).map(publicItem),
  };
}

async function loadOrderWithItems(orderId) {
  const order = await get('SELECT * FROM orders WHERE id = $1', orderId);
  if (!order) return null;
  const items = await all(
    'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
    orderId,
  );
  return publicOrder(order, items);
}

// Recalcule le total d'une commande à partir de ses lignes
// (poids réel pesé quand il est renseigné, sinon poids estimé).
// Si tous les articles sont en état final (collecté / manquant),
// le total devient le total final.
async function recomputeTotals(db, order) {
  const items = await db.all(
    'SELECT * FROM order_items WHERE order_id = $1',
    order.id,
  );
  const itemsTotal = items.reduce((sum, it) => sum + it.line_total_cents, 0);
  const total = itemsTotal + order.delivery_fee_cents + order.service_fee_cents + order.tip_cents;
  const allFinal = items.length > 0 && items.every((it) => it.status !== 'a_collecter');
  await db.run(
    `UPDATE orders SET total_cents = $1, final_total_cents = $2, updated_at = $3
     WHERE id = $4`,
    total, allFinal ? total : null, new Date().toISOString(), order.id,
  );
  return { total, final_total_cents: allFinal ? total : null };
}

export const ordersRouter = Router();

// POST /api/orders — créer une commande (client connecté).
ordersRouter.post('/orders', requireAuth, async (req, res) => {
  const body = req.body || {};
  const mode = body.mode;
  if (mode !== 'livraison' && mode !== 'cueillette') {
    return res.status(400).json({ ok: false, error: 'mode_invalid' });
  }

  const postal_code = String(body.postal_code || '').trim();
  const fees = quoteFees({ postal_code, mode });
  if (mode === 'livraison' && !fees.postal_valid) {
    return res.status(400).json({ ok: false, error: 'postal_invalid' });
  }

  const tip_cents = Math.max(0, Math.floor(Number(body.tip_cents) || 0));
  // Pourboire en livraison seulement (comme dans l'appli web).
  const tip = mode === 'livraison' ? tip_cents : 0;

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'items_required' });
  }

  // Validation des articles et calcul des lignes.
  const lines = [];
  for (const item of items) {
    const product_id = Number(item?.product_id);
    const product = await get('SELECT * FROM products WHERE id = $1', product_id);
    if (!product) {
      return res.status(400).json({ ok: false, error: 'product_not_found', product_id });
    }
    if (!product.available || product.price_cents <= 0) {
      return res.status(400).json({ ok: false, error: 'product_unavailable', product_id });
    }

    let quantity = 1;
    let weight_grams = null;
    let line_total;
    if (product.sold_by_weight) {
      weight_grams = Number(item?.weight_grams);
      if (!Number.isInteger(weight_grams) || weight_grams < WEIGHT_MIN_G || weight_grams > WEIGHT_MAX_G) {
        return res.status(400).json({
          ok: false, error: 'weight_invalid', product_id,
          weight_min_g: WEIGHT_MIN_G, weight_max_g: WEIGHT_MAX_G,
        });
      }
      // Prix stocké au kg : total estimé sur le poids entier entré.
      line_total = Math.round((weight_grams * product.price_cents) / 1000);
    } else {
      quantity = Math.floor(Number(item?.quantity) || 1);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ ok: false, error: 'quantity_invalid', product_id });
      }
      line_total = quantity * product.price_cents;
    }
    lines.push({
      product_id: product.id,
      product_name: product.name,
      quantity,
      weight_grams,
      unit_price_cents: product.price_cents,
      line_total_cents: line_total,
    });
  }

  const itemsTotal = lines.reduce((sum, l) => sum + l.line_total_cents, 0);
  const total = itemsTotal + fees.delivery_fee_cents + fees.service_fee_cents + tip;
  const now = new Date().toISOString();

  const order = await transaction(async (db) => {
    const result = await db.run(
      `INSERT INTO orders
         (customer_id, mode, status, address, postal_code, phone, note,
          delivery_fee_cents, service_fee_cents, tip_cents,
          estimated_total_cents, total_cents, delivery_zone, created_at, updated_at)
       VALUES ($1, $2, 'recue', $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $12)
       RETURNING *`,
      req.customer.id, mode,
      String(body.address || '').trim() || null,
      mode === 'livraison' ? postal_code : null,
      String(body.phone || req.customer.phone || '').trim() || null,
      String(body.note || '').trim() || null,
      fees.delivery_fee_cents, fees.service_fee_cents, tip,
      total, fees.delivery_zone, now,
    );
    const created = result.rows[0];
    for (const l of lines) {
      await db.run(
        `INSERT INTO order_items
           (order_id, product_id, product_name, quantity, weight_grams,
            unit_price_cents, line_total_cents, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'a_collecter')`,
        created.id, l.product_id, l.product_name, l.quantity, l.weight_grams,
        l.unit_price_cents, l.line_total_cents,
      );
    }
    return created;
  });

  const full = await loadOrderWithItems(order.id);
  return res.status(201).json({ ok: true, order: full });
});

// GET /api/orders/mine — commandes du client connecté.
ordersRouter.get('/orders/mine', requireAuth, async (req, res) => {
  const orders = await all(
    'SELECT * FROM orders WHERE customer_id = $1 ORDER BY id DESC',
    req.customer.id,
  );
  const out = [];
  for (const order of orders) {
    const items = await all(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
      order.id,
    );
    out.push(publicOrder(order, items));
  }
  return res.json({ ok: true, orders: out });
});

// GET /api/orders — toutes les commandes (admin).
ordersRouter.get('/orders', requireAdmin, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const orders = status && ORDER_STATUSES.includes(status)
    ? await all('SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT $2', status, limit)
    : await all('SELECT * FROM orders ORDER BY id DESC LIMIT $1', limit);
  const out = [];
  for (const order of orders) {
    const items = await all(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
      order.id,
    );
    out.push(publicOrder(order, items));
  }
  return res.json({ ok: true, orders: out });
});

// PATCH /api/orders/{id}/status — statut de commande (admin).
ordersRouter.patch('/orders/:id/status', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').trim();
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'status_invalid', allowed: ORDER_STATUSES });
  }
  const order = await get('SELECT * FROM orders WHERE id = $1', id);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  const now = new Date().toISOString();
  // En terminant la commande, le total courant devient le total final
  // s'il n'a pas déjà été fixé par la pesée.
  const finalTotal = status === 'terminee' && order.final_total_cents == null
    ? order.total_cents
    : order.final_total_cents;
  await run(
    'UPDATE orders SET status = $1, final_total_cents = $2, updated_at = $3 WHERE id = $4',
    status, finalTotal, now, id,
  );
  return res.json({ ok: true, order: await loadOrderWithItems(id) });
});

// PATCH /api/orders/{id}/items/{itemId}/status — collecte (admin).
ordersRouter.patch('/orders/:id/items/:itemId/status', requireAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const status = String(req.body?.status || '').trim();
  if (!ITEM_STATUSES.includes(status) || status === 'a_collecter') {
    return res.status(400).json({ ok: false, error: 'status_invalid', allowed: ['collecte', 'manquant'] });
  }
  const order = await get('SELECT * FROM orders WHERE id = $1', orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  const item = await get(
    'SELECT * FROM order_items WHERE id = $1 AND order_id = $2',
    itemId, orderId,
  );
  if (!item) return res.status(404).json({ ok: false, error: 'item_not_found' });

  let replacement_product_id = null;
  if (status === 'manquant' && req.body?.replacement_product_id != null) {
    replacement_product_id = Number(req.body.replacement_product_id);
    const replacement = await get('SELECT * FROM products WHERE id = $1', replacement_product_id);
    if (!replacement) {
      return res.status(400).json({ ok: false, error: 'replacement_not_found' });
    }
    if (!replacement.available || replacement.price_cents <= 0) {
      return res.status(400).json({ ok: false, error: 'replacement_unavailable' });
    }
  }

  await run(
    'UPDATE order_items SET status = $1, replacement_product_id = $2 WHERE id = $3',
    status, replacement_product_id, itemId,
  );
  // Un article manquant ne coûte rien : sa ligne tombe à 0.
  if (status === 'manquant') {
    await run('UPDATE order_items SET line_total_cents = 0 WHERE id = $1', itemId);
  }
  const updatedOrder = await get('SELECT * FROM orders WHERE id = $1', orderId);
  await transaction(async (db) => recomputeTotals(db, updatedOrder));
  return res.json({ ok: true, order: await loadOrderWithItems(orderId) });
});

// PATCH /api/orders/{id}/items/{itemId}/weight — poids réel pesé (admin).
ordersRouter.patch('/orders/:id/items/:itemId/weight', requireAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const weight_grams = Number(req.body?.weight_grams);
  if (!Number.isInteger(weight_grams) || weight_grams < 1 || weight_grams > COLLECTED_MAX_G) {
    return res.status(400).json({
      ok: false, error: 'weight_invalid', weight_min_g: 1, weight_max_g: COLLECTED_MAX_G,
    });
  }
  const order = await get('SELECT * FROM orders WHERE id = $1', orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
  const item = await get(
    `SELECT oi.*, p.sold_by_weight FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.id = $1 AND oi.order_id = $2`,
    itemId, orderId,
  );
  if (!item) return res.status(404).json({ ok: false, error: 'item_not_found' });
  if (!item.sold_by_weight) {
    return res.status(400).json({ ok: false, error: 'not_sold_by_weight' });
  }

  // Montant final = poids réel pesé × prix au kg.
  const line_total = Math.round((weight_grams * item.unit_price_cents) / 1000);
  await run(
    `UPDATE order_items
     SET collected_weight_grams = $1, line_total_cents = $2, status = 'collecte'
     WHERE id = $3`,
    weight_grams, line_total, itemId,
  );
  const updatedOrder = await get('SELECT * FROM orders WHERE id = $1', orderId);
  const totals = await transaction(async (db) => recomputeTotals(db, updatedOrder));
  return res.json({
    ok: true,
    order: await loadOrderWithItems(orderId),
    total_cents: totals.total,
    final_total_cents: totals.final_total_cents,
  });
});
