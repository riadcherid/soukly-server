// Tableau de bord admin (v0.7.9) — ventes et chiffre d'affaires.
//
// GET /api/admin/stats/summary?from=AAAA-MM-JJ&to=AAAA-MM-JJ
//   Totaux de la période (30 derniers jours par défaut, dates de
//   Montréal) + série par jour.
// GET /api/admin/stats/top-products?from=...&to=...&limit=10
//   Produits les plus vendus de la période (par chiffre d'affaires).
//
// Les commandes annulées sont EXCLUES du chiffre d'affaires (ce
// sont des ventes annulées, pas des ventes) mais comptées à part
// dans le résumé. Les totaux par article utilisent line_total_cents
// (prix estimé à la commande) ; le total de la commande utilise
// final_total_cents quand il est fixé, sinon total_cents (même règle
// que le rapport du jour).
import { Router } from 'express';
import { all } from './db.js';
import { requireAdmin } from './admin.js';
import { montrealToday } from './reports.js';

const MONTREAL_DATE_SQL =
  `(created_at::timestamptz AT TIME ZONE 'America/Toronto')::date`;

/// Même expression, pour une autre colonne (ex. o.created_at).
function montrealDateSql(column) {
  return `(${column}::timestamptz AT TIME ZONE 'America/Toronto')::date`;
}

const MAX_RANGE_DAYS = 365;

/// Marge produits d'une ligne de commande (fragment SQL, v0.7.14) :
/// prix de vente (line_total_cents — montant final pesé ou estimé)
/// moins coût d'achat. Le coût utilise le prix d'achat figé sur la
/// ligne, ou, pour les anciennes lignes (NULL), le prix d'achat
/// actuel du produit. Article au poids : coût = poids effectif
/// (pesé, sinon estimé) × prix d'achat au kg / 1000. Article
/// manquant : 0 (rien reçu, rien acheté — sa ligne est déjà à 0).
/// Les frais de livraison/service ne comptent pas dans la marge
/// produits. `oi` = order_items, `p` = products (jointure LEFT).
export const ORDER_LINE_MARGIN_SQL = `
  CASE
    WHEN oi.status = 'manquant' THEN 0
    WHEN oi.weight_grams IS NOT NULL THEN
      oi.line_total_cents - ROUND(COALESCE(oi.collected_weight_grams, oi.weight_grams) * COALESCE(oi.purchase_price_cents, p.purchase_price_cents, 0) / 1000.0)
    ELSE
      oi.line_total_cents - oi.quantity * COALESCE(oi.purchase_price_cents, p.purchase_price_cents, 0)
  END`;

/// Marge d'une ligne, en cents (même règle que le SQL ci-dessus) —
/// version JS pure, testée dans test/stats.test.mjs. `line` :
/// { line_total_cents, quantity, weight_grams?,
///   collected_weight_grams?, purchase_price_cents?, status? }.
export function lineMarginCents(line) {
  if (!line || line.status === 'manquant') return 0;
  const purchase = Math.max(0, Math.floor(Number(line.purchase_price_cents) || 0));
  const total = Math.max(0, Math.floor(Number(line.line_total_cents) || 0));
  if (line.weight_grams != null) {
    const grams = Math.max(
      0,
      Math.floor(Number(line.collected_weight_grams ?? line.weight_grams) || 0),
    );
    return total - Math.round((grams * purchase) / 1000);
  }
  const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
  return total - qty * purchase;
}

/// Pourcentage de marge d'un produit : (vente − achat) / achat × 100.
/// null quand le prix d'achat est à 0 (aucun % affichable — l'appli
/// affiche « — »). Ex. achat 500, vente 575 → +15 %.
export function marginPercent(purchaseCents, saleCents) {
  const purchase = Number(purchaseCents) || 0;
  if (purchase <= 0) return null;
  return ((Number(saleCents) - purchase) / purchase) * 100;
}

export function isValidDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function daysBefore(today, n) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/// Valide et normalise la période demandée (query.from / query.to).
/// Défaut : les 30 derniers jours jusqu'à aujourd'hui (Montréal).
/// Renvoie { from, to } ou lance une Error avec error.code =
/// 'date_invalid' | 'range_invalid' | 'range_too_long'.
export function parseRange(query) {
  const today = montrealToday();
  const from = query.from ?? daysBefore(today, 29);
  const to = query.to ?? today;
  if (!isValidDate(from) || !isValidDate(to)) {
    const err = new Error('date invalide');
    err.code = 'date_invalid';
    throw err;
  }
  if (from > to) {
    const err = new Error('from doit être avant to');
    err.code = 'range_invalid';
    throw err;
  }
  const span =
    (Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000) + 1;
  if (span > MAX_RANGE_DAYS) {
    const err = new Error('période trop longue');
    err.code = 'range_too_long';
    throw err;
  }
  return { from, to };
}

function rangeError(res, err) {
  const status = err.code === 'date_invalid' || err.code === 'range_invalid' || err.code === 'range_too_long' ? 400 : 500;
  return res.status(status).json({ ok: false, error: err.code ?? 'internal_error' });
}

export const statsRouter = Router();
statsRouter.use(requireAdmin);

// GET /api/admin/stats/summary — totaux + série par jour.
statsRouter.get('/stats/summary', async (req, res) => {
  let range;
  try {
    range = parseRange(req.query);
  } catch (err) {
    return rangeError(res, err);
  }
  const { from, to } = range;
  const totals = await all(
    `SELECT COUNT(*)::int AS orders_count,
            COALESCE(SUM(CASE WHEN status <> 'annulee'
              THEN COALESCE(final_total_cents, total_cents) ELSE 0 END), 0)::int AS total_cents,
            COALESCE(SUM(CASE WHEN status = 'terminee' THEN 1 ELSE 0 END), 0)::int AS terminees,
            COALESCE(SUM(CASE WHEN status = 'annulee' THEN 1 ELSE 0 END), 0)::int AS annulees,
            COALESCE(SUM(CASE WHEN mode = 'livraison' THEN 1 ELSE 0 END), 0)::int AS livraisons,
            COALESCE(SUM(CASE WHEN mode <> 'livraison' THEN 1 ELSE 0 END), 0)::int AS cueillettes
       FROM orders WHERE ${MONTREAL_DATE_SQL} >= $1 AND ${MONTREAL_DATE_SQL} <= $2`,
    from,
    to,
  );
  const byDay = await all(
    `SELECT ${MONTREAL_DATE_SQL} AS date,
            COUNT(*)::int AS orders_count,
            COALESCE(SUM(CASE WHEN status <> 'annulee'
              THEN COALESCE(final_total_cents, total_cents) ELSE 0 END), 0)::int AS total_cents
       FROM orders WHERE ${MONTREAL_DATE_SQL} >= $1 AND ${MONTREAL_DATE_SQL} <= $2
       GROUP BY date ORDER BY date`,
    from,
    to,
  );
  // Marge produits de la période (v0.7.14) : somme des marges des
  // lignes vendues, commandes annulées exclues. Les lignes sans prix
  // d'achat figé (anciennes) utilisent le prix d'achat actuel du
  // produit (voir ORDER_LINE_MARGIN_SQL).
  const margin = await all(
    `SELECT COALESCE(SUM(${ORDER_LINE_MARGIN_SQL}), 0)::int AS margin_cents
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.status <> 'annulee'
        AND ${montrealDateSql('o.created_at')} >= $1
        AND ${montrealDateSql('o.created_at')} <= $2`,
    from,
    to,
  );
  const t = totals[0];
  const salesCount = t.orders_count - t.annulees;
  return res.json({
    ok: true,
    stats: {
      from,
      to,
      orders_count: t.orders_count,
      total_cents: t.total_cents,
      margin_cents: margin[0]?.margin_cents ?? 0,
      avg_order_cents: salesCount > 0 ? Math.round(t.total_cents / salesCount) : 0,
      terminees: t.terminees,
      annulees: t.annulees,
      livraisons: t.livraisons,
      cueillettes: t.cueillettes,
      by_day: byDay.map((d) => ({
        date: String(d.date).slice(0, 10),
        orders_count: d.orders_count,
        total_cents: d.total_cents,
      })),
    },
  });
});

// GET /api/admin/stats/top-products — meilleurs vendeurs de la période.
statsRouter.get('/stats/top-products', async (req, res) => {
  let range;
  try {
    range = parseRange(req.query);
  } catch (err) {
    return rangeError(res, err);
  }
  const limitRaw = Number.parseInt(req.query.limit ?? '10', 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 50)
    : 10;
  const { from, to } = range;
  const orderDate = montrealDateSql('o.created_at');
  const rows = await all(
    `SELECT oi.product_id, oi.product_name,
            SUM(oi.quantity)::int AS quantity,
            SUM(oi.line_total_cents)::int AS revenue_cents,
            COUNT(DISTINCT oi.order_id)::int AS orders_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.status <> 'annulee'
        AND ${orderDate} >= $1
        AND ${orderDate} <= $2
      GROUP BY oi.product_id, oi.product_name
      ORDER BY revenue_cents DESC, quantity DESC
      LIMIT $3`,
    from,
    to,
    limit,
  );
  return res.json({
    ok: true,
    from,
    to,
    products: rows.map((r) => ({
      product_id: r.product_id,
      product_name: r.product_name,
      quantity: r.quantity,
      revenue_cents: r.revenue_cents,
      orders_count: r.orders_count,
    })),
  });
});
