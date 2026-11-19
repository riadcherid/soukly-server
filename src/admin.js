// Routes admin — miroir des actions `upsertproduct`, `deleteproduct`,
// `upsertcategory`, `saveinventory`, `getaisettings`, `saveaisettings`,
// `describeproductphoto`, `testaikey`, `getgooglesettings`,
// `savegooglesettings`, `testgooglesettings` de l'appli web.
// L'appli web n'a pas d'authentification admin : ici, un jeton simple
// en variable d'environnement (ADMIN_TOKEN) est exigé sur /api/admin/*.
// Les secrets (clé IA, secret Google) sont stockés dans la table
// `settings` et ne sont JAMAIS renvoyés en clair (masqués).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { all, get, run, transaction } from './db.js';
import { fetchJson } from './http.js';
import { photoUrl } from './photos.js';
import { emailSettingsFromStore, sendTestEmail } from './email.js';

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.warn('[admin] ADMIN_TOKEN non défini — les routes /api/admin/* sont fermées (503).');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'admin_not_configured' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'admin_auth_required' });
  }
  return next();
}

// --- Réglages (table `settings`, valeurs JSON) ---

export async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = $1', key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function setSetting(key, value) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    key, JSON.stringify(value), now,
  );
}

// Masque un secret : « GOC…9tBj » (3 premiers + … + 4 derniers).
function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return null;
  if (s.length <= 7) return '****';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function toProduct(row) {
  // Unité de prix : source de vérité pour « vendu au poids »
  // ('lb' | 'kg' = au poids, 'piece' = à l'unité). Le repli sur la
  // colonne historique ne sert que si price_unit est absent.
  // `purchase_price_cents` (v0.7.14) : prix d'achat, ADMIN SEULEMENT
  // — ce sérialiseur n'est utilisé que par les routes admin.
  const priceUnit = row.price_unit || (row.sold_by_weight ? 'lb' : 'piece');
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category_key,
    unit: row.unit,
    price_cents: row.price_cents,
    purchase_price_cents: row.purchase_price_cents ?? 0,
    price_unit: priceUnit,
    sold_by_weight: priceUnit === 'lb' || priceUnit === 'kg',
    on_special: row.on_special === true,
    prepared: row.prepared === true,
    deposit_cents: row.deposit_cents ?? 0,
    available: row.available === true,
    image_key: row.image_key,
    photo_url: photoUrl(row.image_key),
  };
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || 'rayon';
}

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// --- Produits ---

// GET /api/admin/products — catalogue admin complet (rayons + produits),
// prix d'achat inclus (`purchase_price_cents`, ADMIN SEULEMENT).
// L'inventaire du matin et les écrans admin « Produits » / formulaire
// produit l'utilisent : le catalogue public ne renvoie jamais le prix
// d'achat, donc l'inventaire calculait une marge « — » partout (v0.7.15).
adminRouter.get('/products', async (req, res) => {
  const categories = await all(
    'SELECT key, label, sort FROM categories ORDER BY sort',
  );
  const products = (await all('SELECT * FROM products ORDER BY id')).map(
    toProduct,
  );
  res.json({ ok: true, categories, products });
});

// POST /api/admin/products — ajouter / modifier un produit.
// Le prix est en cents par kg pour les produits au poids (la conversion
// $/lb → $/kg se fait côté appli admin, comme dans l'appli web).
adminRouter.post('/products', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const category_key = String(body.category_key || '').trim();
  const unit = String(body.unit || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!category_key) return res.status(400).json({ ok: false, error: 'category_required' });
  if (!unit) return res.status(400).json({ ok: false, error: 'unit_required' });
  const category = await get('SELECT key FROM categories WHERE key = $1', category_key);
  if (!category) return res.status(400).json({ ok: false, error: 'category_not_found' });

  const price_cents = Math.max(0, Math.floor(Number(body.price_cents) || 0));
  // Prix d'achat (v0.7.14) : ce que Riad paie chez Épilys. Admin
  // seulement : il ne sort jamais dans le catalogue public.
  const purchase_price_cents = Math.max(0, Math.floor(Number(body.purchase_price_cents) || 0));
  // Unité de prix : 'piece' | 'lb' | 'kg'. Si elle est absente (ancien
  // client), on la déduit de sold_by_weight. Le poids se déduit de
  // l'unité ('lb' | 'kg' = au poids) ; la colonne historique reste
  // synchronisée pour les lectures internes (commandes, taxes).
  const priceUnitRaw = String(body.price_unit || '').trim();
  const price_unit = ['piece', 'lb', 'kg'].includes(priceUnitRaw)
    ? priceUnitRaw
    : (body.sold_by_weight === true ? 'lb' : 'piece');
  const sold_by_weight = price_unit === 'lb' || price_unit === 'kg';
  const on_special = body.on_special === true;
  const prepared = body.prepared === true;
  const deposit_cents = Math.max(0, Math.floor(Number(body.deposit_cents) || 0));
  const available = body.available === true;
  const description = String(body.description || '').trim();
  const image_key = body.image_key != null ? String(body.image_key) : null;

  const id = body.id != null ? Number(body.id) : null;
  let product;
  if (id != null && Number.isInteger(id) && id > 0) {
    const existing = await get('SELECT id FROM products WHERE id = $1', id);
    if (existing) {
      const result = await run(
        `UPDATE products SET name = $1, description = $2, category_key = $3, unit = $4,
           price_cents = $5, sold_by_weight = $6, available = $7, image_key = $8,
           prepared = $9, price_unit = $10, on_special = $11, deposit_cents = $12,
           purchase_price_cents = $13
         WHERE id = $14 RETURNING *`,
        name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared, price_unit, on_special, deposit_cents, purchase_price_cents, id,
      );
      product = result.rows[0];
    } else {
      const result = await run(
        `INSERT INTO products
           (id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared, price_unit, on_special, deposit_cents, purchase_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared, price_unit, on_special, deposit_cents, purchase_price_cents,
      );
      product = result.rows[0];
    }
  } else {
    const next = await get('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM products');
    const result = await run(
      `INSERT INTO products
         (id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared, price_unit, on_special, deposit_cents, purchase_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      next.id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared, price_unit, on_special, deposit_cents, purchase_price_cents,
    );
    product = result.rows[0];
  }
  return res.status(201).json({ ok: true, product: toProduct(product) });
});

// DELETE /api/admin/products/{id} — retirer un produit.
adminRouter.delete('/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  const product = await get('SELECT id FROM products WHERE id = $1', id);
  if (!product) return res.status(404).json({ ok: false, error: 'product_not_found' });
  try {
    await run('DELETE FROM products WHERE id = $1', id);
  } catch (err) {
    // Produit référencé par une commande : refus (intégrité référentielle).
    if (err.code === '23503') {
      return res.status(409).json({ ok: false, error: 'product_in_use' });
    }
    throw err;
  }
  return res.json({ ok: true, deleted_id: id });
});

// --- Clients ---

// Mot de passe de la Zone dangereuse : un mot de passe séparé du jeton
// admin, choisi par Riad, haché bcrypt dans la table `settings`
// (clé `danger_password`). Il est exigé pour TOUTE suppression de
// compte (un, plusieurs ou tous) — le jeton admin seul ne suffit plus.
const DANGER_PASSWORD_MIN_LENGTH = 8;

async function getDangerPasswordHash() {
  const stored = await getSetting('danger_password');
  return stored?.hash || null;
}

// Vérifie le mot de passe fourni : { ok: true } ou { ok: false, error }.
// Tant qu'aucun mot de passe n'est défini (ancienne appli, avant la
// première définition), la suppression reste possible sans mot de
// passe — dès qu'il est défini, il est exigé partout.
async function verifyDangerPassword(password) {
  const hash = await getDangerPasswordHash();
  if (!hash) return { ok: true };
  const given = String(password || '');
  if (!given) return { ok: false, error: 'danger_password_required' };
  if (!bcrypt.compareSync(given, hash)) {
    return { ok: false, error: 'danger_password_invalid' };
  }
  return { ok: true };
}

// Réponse d'erreur standard pour un mot de passe refusé (403).
function dangerPasswordError(res, check) {
  return res.status(403).json({ ok: false, error: check.error });
}

// GET /api/admin/danger-password — le mot de passe est-il défini ?
adminRouter.get('/danger-password', async (req, res) => {
  const hash = await getDangerPasswordHash();
  return res.json({ ok: true, has_password: Boolean(hash) });
});

// POST /api/admin/danger-password — définir / changer le mot de passe.
// Corps : { current_password?, new_password }. Si un mot de passe existe
// déjà, current_password doit correspondre. Minimum 8 caractères.
adminRouter.post('/danger-password', async (req, res) => {
  const body = req.body || {};
  const existing = await getDangerPasswordHash();
  if (existing) {
    const current = String(body.current_password || '');
    if (!bcrypt.compareSync(current, existing)) {
      return res.status(403).json({ ok: false, error: 'danger_password_invalid' });
    }
  }
  const next = String(body.new_password || '');
  if (next.length < DANGER_PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ ok: false, error: 'password_too_short' });
  }
  await setSetting('danger_password', { hash: bcrypt.hashSync(next, 10) });
  return res.json({ ok: true, has_password: true });
});

// GET /api/admin/customers — liste des comptes (nom d'utilisateur,
// e-mail, téléphone, date d'inscription, nombre de commandes).
adminRouter.get('/customers', async (req, res) => {
  const rows = await all(
    `SELECT c.id, c.username, c.email, c.phone, c.created_at,
            COUNT(o.id) AS orders_count
     FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC`,
  );
  return res.json({
    ok: true,
    customers: rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      phone: r.phone,
      created_at: r.created_at,
      orders_count: Number(r.orders_count) || 0,
    })),
  });
});

// POST /api/admin/customers/delete-selected — supprimer UN ou PLUSIEURS
// comptes (cochés dans l'appli) et leurs commandes. Corps :
// { ids: [1, 2], danger_password }. Une seule transaction : d'abord
// les messages et positions livreur des commandes concernées
// (order_messages / courier_positions référencent orders(id) sans
// ON DELETE CASCADE — sinon le DELETE des commandes viole la clé
// étrangère), puis les lignes des commandes, puis leurs commandes,
// puis les comptes. Ne touche jamais aux produits, rayons, réglages
// ou à l'inventaire.
adminRouter.post('/customers/delete-selected', async (req, res) => {
  const check = await verifyDangerPassword(req.body?.danger_password);
  if (!check.ok) return dangerPasswordError(res, check);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const clean = [...new Set(
    ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0),
  )];
  if (clean.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids_required' });
  }
  const result = await transaction(async (db) => {
    await db.run(
      'DELETE FROM order_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))',
      clean,
    );
    await db.run(
      'DELETE FROM courier_positions WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))',
      clean,
    );
    await db.run(
      'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))',
      clean,
    );
    const orders = await db.run('DELETE FROM orders WHERE customer_id = ANY($1)', clean);
    const customers = await db.run('DELETE FROM customers WHERE id = ANY($1)', clean);
    return {
      deleted_customers: customers.rowCount,
      deleted_orders: orders.rowCount,
    };
  });
  return res.json({ ok: true, ...result });
});

// DELETE /api/admin/customers — supprimer TOUS les comptes clients et
// leurs commandes (réinscription propre, ex. après un changement du
// formulaire d'inscription). Mot de passe de la Zone dangereuse exigé
// dans le corps : { danger_password }. Une seule transaction : d'abord
// les messages et positions livreur (order_messages /
// courier_positions référencent orders(id) sans ON DELETE CASCADE),
// puis les lignes des commandes (order_items), puis les commandes,
// puis les clients — `orders.customer_id` référence `customers(id)`
// sans ON DELETE. Ne touche jamais aux produits, rayons, réglages ou
// à l'inventaire.
adminRouter.delete('/customers', async (req, res) => {
  const check = await verifyDangerPassword(req.body?.danger_password);
  if (!check.ok) return dangerPasswordError(res, check);
  const result = await transaction(async (db) => {
    await db.run('DELETE FROM order_messages');
    await db.run('DELETE FROM courier_positions');
    await db.run('DELETE FROM order_items');
    const orders = await db.run('DELETE FROM orders');
    const customers = await db.run('DELETE FROM customers');
    return {
      deleted_customers: customers.rowCount,
      deleted_orders: orders.rowCount,
    };
  });
  return res.json({ ok: true, ...result });
});

// --- Livreurs (espace Livreur, v0.7.0) ---

// Comptes livreurs : nom d'utilisateur + mot de passe (haché bcrypt),
// créés par l'admin. Pas de vérification par e-mail : l'admin crée le
// compte et donne les identifiants au livreur. Même règle de nom
// d'utilisateur que les clients (3 à 30 caractères, minuscules).
const COURIER_USERNAME_REGEX = /^[a-z0-9._-]{3,30}$/;
const COURIER_PASSWORD_MIN_LENGTH = 8;

function publicCourierRow(row) {
  // Disponibilité : un livreur est « disponible » s'il n'a aucune
  // commande assignée non terminée et non annulée. La commande en
  // cours (la plus ancienne) est renvoyée pour l'afficher à l'admin.
  const currentOrderId =
    row.current_order_id != null ? Number(row.current_order_id) : null;
  return {
    id: row.id,
    username: row.username,
    name: row.name || row.username,
    created_at: row.created_at,
    available: currentOrderId == null,
    current_order_id: currentOrderId,
  };
}

// Commande en cours d'un livreur (assignée, non terminée ni annulée),
// ou null. Sert à la disponibilité (liste) et au refus de
// suppression : même règle aux deux endroits.
async function courierActiveOrderId(courierId) {
  const row = await get(
    `SELECT id FROM orders WHERE courier_id = $1
     AND status NOT IN ('terminee', 'annulee') ORDER BY id LIMIT 1`,
    courierId,
  );
  return row?.id ?? null;
}

// POST /api/admin/couriers — créer un compte livreur.
// Corps : { username, password, name? }. Mot de passe 8 car. min.
adminRouter.post('/couriers', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim() || null;
  if (!COURIER_USERNAME_REGEX.test(username)) {
    return res.status(400).json({ ok: false, error: 'username_invalid' });
  }
  if (password.length < COURIER_PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ ok: false, error: 'password_too_short' });
  }
  const taken = await get('SELECT id FROM couriers WHERE username = $1', username);
  if (taken) return res.status(409).json({ ok: false, error: 'username_taken' });
  const result = await run(
    `INSERT INTO couriers (username, name, password_hash, created_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    username, name, bcrypt.hashSync(password, 10), new Date().toISOString(),
  );
  return res.status(201).json({ ok: true, courier: publicCourierRow(result.rows[0]) });
});

// GET /api/admin/couriers — liste des livreurs, avec leur
// disponibilité : `available` (aucune commande en cours) et
// `current_order_id` (la commande en cours, null si disponible).
// Une seule requête : la sous-requête trouve la commande en cours
// de chaque livreur (la plus ancienne).
adminRouter.get('/couriers', async (req, res) => {
  const rows = await all(
    `SELECT c.*,
            (SELECT o.id FROM orders o WHERE o.courier_id = c.id
             AND o.status NOT IN ('terminee', 'annulee')
             ORDER BY o.id LIMIT 1) AS current_order_id
     FROM couriers c ORDER BY c.username`,
  );
  return res.json({ ok: true, couriers: rows.map(publicCourierRow) });
});

// DELETE /api/admin/couriers/{id} — supprimer un compte livreur.
// Refusé s'il a des livraisons en cours (toute commande assignée non
// terminée ni annulée) : réassignez-les d'abord. Les commandes
// terminées gardent leur historique (courier_id passe à NULL,
// ON DELETE SET NULL).
adminRouter.delete('/couriers/:id', async (req, res) => {
  const id = Number(req.params.id);
  const courier = await get('SELECT id FROM couriers WHERE id = $1', id);
  if (!courier) return res.status(404).json({ ok: false, error: 'courier_not_found' });
  const activeOrderId = await courierActiveOrderId(id);
  if (activeOrderId != null) {
    return res.status(409).json({ ok: false, error: 'courier_has_deliveries' });
  }
  await run('DELETE FROM couriers WHERE id = $1', id);
  return res.json({ ok: true, deleted_id: id });
});

// --- Rayons ---

// GET /api/admin/categories — liste des rayons avec le nombre de
// produits dans chacun (écran admin « Rayons »).
adminRouter.get('/categories', async (req, res) => {
  const categories = await all(
    `SELECT c.key, c.label, c.sort, COUNT(p.id)::int AS product_count
     FROM categories c LEFT JOIN products p ON p.category_key = c.key
     GROUP BY c.key, c.label, c.sort ORDER BY c.sort`,
  );
  return res.json({ ok: true, categories });
});

// POST /api/admin/categories — ajouter / renommer un rayon.
adminRouter.post('/categories', async (req, res) => {
  const body = req.body || {};
  const label = String(body.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, error: 'label_required' });
  const key = String(body.key || '').trim() || slugify(label);
  const existing = await get('SELECT key FROM categories WHERE key = $1', key);
  let sort = Number(body.sort);
  if (!Number.isInteger(sort) || sort < 1) {
    const row = await get('SELECT COALESCE(MAX(sort), 0) + 1 AS sort FROM categories');
    sort = row.sort;
  }
  if (existing) {
    await run('UPDATE categories SET label = $1, sort = $2 WHERE key = $3', label, sort, key);
  } else {
    await run(
      'INSERT INTO categories (key, label, sort) VALUES ($1, $2, $3)',
      key, label, sort,
    );
  }
  const category = await get('SELECT key, label, sort FROM categories WHERE key = $1', key);
  return res.status(201).json({ ok: true, category });
});

// DELETE /api/admin/categories/:key — supprimer un rayon vide.
// Refusé (409) si des produits l'utilisent encore : il faut d'abord
// les déplacer dans un autre rayon (écran « Produits »).
adminRouter.delete('/categories/:key', async (req, res) => {
  const key = String(req.params.key || '').trim();
  const category = await get('SELECT key FROM categories WHERE key = $1', key);
  if (!category) {
    return res.status(404).json({ ok: false, error: 'category_not_found' });
  }
  const used = await get(
    'SELECT COUNT(*)::int AS count FROM products WHERE category_key = $1',
    key,
  );
  if (used && used.count > 0) {
    return res.status(409).json({
      ok: false,
      error: 'category_has_products',
      product_count: used.count,
    });
  }
  await run('DELETE FROM categories WHERE key = $1', key);
  return res.json({ ok: true, deleted_key: key });
});

// --- Inventaire du matin ---

// POST /api/admin/inventory — prix et dispos du jour.
// Corps : { date?, note?, prices: [{ product_id, price_cents, available?,
//   price_unit?, on_special?, deposit_cents?, purchase_price_cents? }] } — l'unité
// ('piece' | 'lb' | 'kg'), le prix spécial, la consigne et le prix
// d'achat (v0.7.14) sont facultatifs (un ancien client ne les envoie pas).
adminRouter.post('/inventory', async (req, res) => {
  const body = req.body || {};
  const prices = body.prices;
  if (!Array.isArray(prices)) {
    return res.status(400).json({ ok: false, error: 'prices_required' });
  }
  let updated = 0;
  for (const p of prices) {
    const product_id = Number(p?.product_id);
    const price_cents = Math.floor(Number(p?.price_cents));
    if (!Number.isInteger(product_id) || !Number.isInteger(price_cents) || price_cents < 0) {
      return res.status(400).json({ ok: false, error: 'price_invalid', product_id });
    }
    const priceUnitRaw = p?.price_unit != null ? String(p.price_unit).trim() : null;
    if (priceUnitRaw != null && !['piece', 'lb', 'kg'].includes(priceUnitRaw)) {
      return res.status(400).json({ ok: false, error: 'price_unit_invalid', product_id });
    }
    const product = await get('SELECT id FROM products WHERE id = $1', product_id);
    if (!product) {
      return res.status(400).json({ ok: false, error: 'product_not_found', product_id });
    }
    const available = p?.available === undefined ? price_cents > 0 : p.available === true;
    const sets = ['price_cents = $1', 'available = $2'];
    const params = [price_cents, available];
    if (priceUnitRaw != null) {
      sets.push(`price_unit = $${params.length + 1}`);
      params.push(priceUnitRaw);
      sets.push(`sold_by_weight = $${params.length + 1}`);
      params.push(priceUnitRaw === 'lb' || priceUnitRaw === 'kg');
    }
    if (p?.on_special !== undefined) {
      sets.push(`on_special = $${params.length + 1}`);
      params.push(p.on_special === true);
    }
    if (p?.deposit_cents !== undefined) {
      const depositCents = Math.floor(Number(p.deposit_cents));
      if (!Number.isInteger(depositCents) || depositCents < 0) {
        return res.status(400).json({ ok: false, error: 'deposit_invalid', product_id });
      }
      sets.push(`deposit_cents = $${params.length + 1}`);
      params.push(depositCents);
    }
    // Prix d'achat (v0.7.14) : fixé à l'inventaire du matin, comme le
    // prix de vente. Il ne sort jamais dans le catalogue public.
    if (p?.purchase_price_cents !== undefined) {
      const purchaseCents = Math.floor(Number(p.purchase_price_cents));
      if (!Number.isInteger(purchaseCents) || purchaseCents < 0) {
        return res.status(400).json({ ok: false, error: 'purchase_price_invalid', product_id });
      }
      sets.push(`purchase_price_cents = $${params.length + 1}`);
      params.push(purchaseCents);
    }
    params.push(product_id);
    await run(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length}`,
      ...params,
    );
    updated += 1;
  }
  const date = String(body.date || new Date().toISOString().slice(0, 10));
  const note = body.note != null ? String(body.note) : null;
  const now = new Date().toISOString();
  await run(
    `INSERT INTO inventory (id, date, note, updated_at) VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
    date, note, now,
  );
  return res.json({ ok: true, updated, date, note });
});

// --- Réglages IA ---

function aiSettingsFromStore(stored) {
  return {
    provider: stored?.provider || 'gemini',
    api_key: stored?.api_key || '',
  };
}

adminRouter.get('/ai-settings', async (req, res) => {
  const stored = await getSetting('ai');
  const s = aiSettingsFromStore(stored);
  return res.json({
    ok: true,
    provider: s.provider,
    api_key_masked: maskSecret(s.api_key),
    has_key: Boolean(s.api_key),
  });
});

adminRouter.post('/ai-settings', async (req, res) => {
  const body = req.body || {};
  const provider = String(body.provider || 'gemini');
  if (provider !== 'gemini' && provider !== 'openai') {
    return res.status(400).json({ ok: false, error: 'provider_invalid' });
  }
  const stored = await getSetting('ai');
  const current = aiSettingsFromStore(stored);
  const api_key = body.api_key != null ? String(body.api_key) : current.api_key;
  await setSetting('ai', { provider, api_key });
  return res.json({
    ok: true,
    provider,
    api_key_masked: maskSecret(api_key),
    has_key: Boolean(api_key),
  });
});

// --- Appels IA (Gemini / OpenAI) ---

const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash'];

async function geminiGenerate({ apiKey, model, parts }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const { status, ok, data } = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!ok) {
    const err = new Error(data?.error?.message || `gemini_${status}`);
    err.status = status;
    err.googleError = data?.error || null;
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text;
}

async function geminiGenerateWithFallback({ apiKey, parts }) {
  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const text = await geminiGenerate({ apiKey, model, parts });
      return { text, model };
    } catch (err) {
      lastError = err;
      // 404 (modèle retiré) ou 429/503 (quota) : essayer le suivant.
      if (err.status !== 404 && err.status !== 429 && err.status !== 503) throw err;
    }
  }
  throw lastError;
}

async function openaiChat({ apiKey, messages }) {
  const { status, ok, data } = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
  });
  if (!ok) {
    const err = new Error(data?.error?.message || `openai_${status}`);
    err.status = status;
    throw err;
  }
  return data?.choices?.[0]?.message?.content || '';
}

function parseAiProductJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// POST /api/admin/ai/describe-photo — description IA en français depuis une photo.
adminRouter.post('/ai/describe-photo', async (req, res) => {
  const body = req.body || {};
  const data_base64 = String(body.data_base64 || '');
  const mime_type = String(body.mime_type || 'image/jpeg');
  const name = String(body.name || '').trim();
  if (!data_base64) return res.status(400).json({ ok: false, error: 'photo_required' });

  const stored = await getSetting('ai');
  const s = aiSettingsFromStore(stored);
  if (!s.api_key) return res.status(400).json({ ok: false, error: 'no_key' });

  const categories = await all('SELECT key, label FROM categories ORDER BY sort');
  const categoryList = categories.map((c) => `${c.key} (${c.label})`).join(', ');
  const prompt =
    `Tu es l'assistant de l'épicerie Soukly. Décris ce produit en une phrase en français, ` +
    `donne son nom exact tel qu'il apparaît sur l'emballage si lisible, sinon un nom simple, ` +
    `et choisis son rayon parmi : ${categoryList}. ` +
    (name ? `Nom indiqué : ${name}. ` : '') +
    `Réponds uniquement en JSON : {"description": "...", "name": "...", "category": "<clé du rayon>"}.`;

  try {
    let text;
    if (s.provider === 'openai') {
      text = await openaiChat({
        apiKey: s.api_key,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime_type};base64,${data_base64}` } },
          ],
        }],
      });
    } else {
      const result = await geminiGenerateWithFallback({
        apiKey: s.api_key,
        parts: [
          { text: prompt },
          { inline_data: { mime_type, data: data_base64 } },
        ],
      });
      text = result.text;
    }
    const parsed = parseAiProductJson(text);
    if (!parsed || !parsed.description) {
      return res.json({
        ok: true,
        description: String(text || '').trim().slice(0, 300),
        suggested_name: name || null,
        suggested_category: null,
        raw: true,
      });
    }
    const categoryOk = categories.some((c) => c.key === parsed.category);
    return res.json({
      ok: true,
      description: String(parsed.description || '').trim(),
      suggested_name: String(parsed.name || name || '').trim() || null,
      suggested_category: categoryOk ? parsed.category : null,
    });
  } catch (err) {
    console.error('[ai/describe-photo]', err.message);
    return res.status(502).json({ ok: false, error: 'ai_error', message: err.message });
  }
});

// POST /api/admin/ai/test-key — tester la clé IA (petit appel texte).
adminRouter.post('/ai/test-key', async (req, res) => {
  const stored = await getSetting('ai');
  const s = aiSettingsFromStore(stored);
  if (!s.api_key) return res.status(400).json({ ok: false, error: 'no_key' });
  try {
    if (s.provider === 'openai') {
      const { ok, data } = await fetchJson('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${s.api_key}` },
      });
      if (!ok) {
        return res.json({ ok: false, valid: false, error: data?.error?.message || 'openai_error' });
      }
      return res.json({ ok: true, valid: true, provider: 'openai' });
    }
    const result = await geminiGenerateWithFallback({
      apiKey: s.api_key,
      parts: [{ text: 'Réponds uniquement : OK' }],
    });
    return res.json({ ok: true, valid: true, provider: 'gemini', model: result.model });
  } catch (err) {
    console.error('[ai/test-key]', err.message);
    return res.json({ ok: false, valid: false, error: err.message });
  }
});

// --- Réglages Google ---

export function googleSettingsFromStore(stored) {
  return {
    client_id: stored?.client_id || process.env.GOOGLE_CLIENT_ID || '',
    client_secret: stored?.client_secret || process.env.GOOGLE_CLIENT_SECRET || '',
    enabled: stored?.enabled !== false,
  };
}

adminRouter.get('/google-settings', async (req, res) => {
  const stored = await getSetting('google');
  const s = googleSettingsFromStore(stored);
  return res.json({
    ok: true,
    client_id: s.client_id,
    client_secret_masked: maskSecret(s.client_secret),
    has_secret: Boolean(s.client_secret),
    enabled: s.enabled,
  });
});

adminRouter.post('/google-settings', async (req, res) => {
  const body = req.body || {};
  const stored = await getSetting('google');
  const current = googleSettingsFromStore(stored);
  const client_id = body.client_id != null ? String(body.client_id) : current.client_id;
  const client_secret = body.client_secret != null ? String(body.client_secret) : current.client_secret;
  const enabled = body.enabled != null ? body.enabled === true : current.enabled;
  await setSetting('google', { client_id, client_secret, enabled });
  return res.json({
    ok: true,
    client_id,
    client_secret_masked: maskSecret(client_secret),
    has_secret: Boolean(client_secret),
    enabled,
  });
});

// POST /api/admin/google/test — rejouer un faux échange de code chez Google.
// Google répond « Malformed auth code » si le secret est accepté,
// « invalid_client » si le secret est invalide.
adminRouter.post('/google/test', async (req, res) => {
  const stored = await getSetting('google');
  const s = googleSettingsFromStore(stored);
  if (!s.client_id || !s.client_secret) {
    return res.status(400).json({ ok: false, error: 'google_not_configured' });
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'test-code',
      client_id: s.client_id,
      client_secret: s.client_secret,
      redirect_uri: 'postmessage',
    });
    const { status, data } = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const errCode = data?.error;
    if (errCode === 'invalid_client') {
      return res.json({ ok: false, valid: false, error: 'invalid_client', message: data?.error_description || '' });
    }
    if (errCode === 'invalid_grant') {
      // Le code est rejeté mais le secret est accepté : config valide.
      return res.json({ ok: true, valid: true, google_error: errCode, message: data?.error_description || '' });
    }
    return res.json({ ok: false, valid: false, error: errCode || `google_${status}`, message: data?.error_description || '' });
  } catch (err) {
    console.error('[google/test]', err.message);
    return res.status(502).json({ ok: false, error: 'google_unreachable', message: err.message });
  }
});

// --- Réglages e-mail (reçu de commande : Brevo HTTPS, repli SMTP) ---

// GET /api/admin/email-settings — adresse Gmail expéditrice + clé API
// Brevo masquée (jamais en clair), comme les réglages IA/Google.
adminRouter.get('/email-settings', async (req, res) => {
  const stored = await getSetting('email');
  const s = emailSettingsFromStore(stored);
  return res.json({
    ok: true,
    smtp_user: s.smtp_user,
    smtp_app_password_masked: maskSecret(s.smtp_app_password),
    has_app_password: Boolean(s.smtp_app_password),
    brevo_api_key_masked: maskSecret(s.brevo_api_key),
    has_brevo_key: Boolean(s.brevo_api_key),
    smtp_from_name: s.smtp_from_name,
  });
});

adminRouter.post('/email-settings', async (req, res) => {
  const body = req.body || {};
  const stored = await getSetting('email');
  const current = emailSettingsFromStore(stored);
  const smtp_user = body.smtp_user != null ? String(body.smtp_user).trim() : current.smtp_user;
  // Mot de passe vide = on garde celui enregistré (comme la clé IA).
  const smtp_app_password = body.smtp_app_password != null && String(body.smtp_app_password) !== ''
    ? String(body.smtp_app_password)
    : current.smtp_app_password;
  // Clé Brevo vide = on garde celle enregistrée.
  const brevo_api_key = body.brevo_api_key != null && String(body.brevo_api_key) !== ''
    ? String(body.brevo_api_key).trim()
    : current.brevo_api_key;
  const smtp_from_name = body.smtp_from_name != null
    ? String(body.smtp_from_name).trim() || 'Soukly'
    : current.smtp_from_name;
  await setSetting('email', { smtp_user, smtp_app_password, brevo_api_key, smtp_from_name });
  return res.json({
    ok: true,
    smtp_user,
    smtp_app_password_masked: maskSecret(smtp_app_password),
    has_app_password: Boolean(smtp_app_password),
    brevo_api_key_masked: maskSecret(brevo_api_key),
    has_brevo_key: Boolean(brevo_api_key),
    smtp_from_name,
  });
});

// POST /api/admin/email/test — envoie un e-mail de test à l'adresse
// Gmail configurée. Renvoie ok ou l'erreur réelle (Brevo ou Gmail).
adminRouter.post('/email/test', async (req, res) => {
  const result = await sendTestEmail();
  if (!result.ok) {
    if (result.error === 'email_not_configured') {
      return res.status(400).json({ ok: false, error: 'email_not_configured' });
    }
    return res.json({ ok: false, valid: false, error: result.error });
  }
  return res.json({ ok: true, valid: true, to: result.to });
});
