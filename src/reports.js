// Rapport du jour (admin seulement) — v0.7.6.
//
// Chaque commande a un numéro dans le jour (daily_number : le
// compteur repart à 1 chaque jour, fuseau de Montréal). Le rapport
// du jour liste les commandes du jour dans l'ordre, avec leur numéro
// (« Commande 6/191126 »), leur date et leur code à 6 chiffres ;
// chaque nouvelle commande s'y ajoute toute seule. En fin de
// journée, l'admin clôture le rapport (totaux figés) ; le lendemain
// repart à 1.
import { Router } from 'express';
import { all, get, run } from './db.js';
import { requireAdmin } from './admin.js';
import { loadOrderWithItems } from './orders.js';

const MONTREAL_DATE_SQL =
  `(created_at::timestamptz AT TIME ZONE 'America/Toronto')::date`;

/// Date du jour à Montréal, au format AAAA-MM-JJ.
export function montrealToday() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Toronto',
  });
}

function isValidDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function formatDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function displayedTotal(order) {
  return order.final_total_cents ?? order.total_cents ?? 0;
}

async function dayOrders(date) {
  const rows = await all(
    `SELECT id FROM orders WHERE ${MONTREAL_DATE_SQL} = $1 ORDER BY daily_number, id`,
    date,
  );
  const orders = [];
  for (const row of rows) {
    const full = await loadOrderWithItems(row.id);
    if (full) orders.push(full);
  }
  return orders;
}

function totalsFor(orders) {
  return {
    orders_count: orders.length,
    total_cents: orders.reduce((sum, o) => sum + displayedTotal(o), 0),
    livraisons: orders.filter((o) => o.mode === 'livraison').length,
    cueillettes: orders.filter((o) => o.mode !== 'livraison').length,
    terminees: orders.filter((o) => o.status === 'terminee').length,
  };
}

export const reportsRouter = Router();
reportsRouter.use(requireAdmin);

// GET /api/admin/reports — jours avec des commandes (plus récent
// d'abord), avec l'état de clôture de chaque jour.
reportsRouter.get('/reports', async (req, res) => {
  const days = await all(
    `SELECT ${MONTREAL_DATE_SQL} AS report_date,
            COUNT(*)::int AS orders_count,
            COALESCE(SUM(COALESCE(final_total_cents, total_cents)), 0)::int AS total_cents
       FROM orders GROUP BY report_date ORDER BY report_date DESC`,
  );
  const closed = await all(
    'SELECT report_date, closed_at FROM daily_reports',
  );
  const closedByDate = new Map(
    closed.map((r) => [r.report_date, r.closed_at]),
  );
  return res.json({
    ok: true,
    reports: days.map((d) => {
      const date = formatDate(d.report_date);
      return {
        date,
        orders_count: d.orders_count,
        total_cents: d.total_cents,
        closed_at: closedByDate.get(date) ?? null,
      };
    }),
  });
});

// GET /api/admin/reports/:date — rapport d'un jour (commandes +
// totaux + état de clôture).
reportsRouter.get('/reports/:date', async (req, res) => {
  const date = req.params.date;
  if (!isValidDate(date)) {
    return res.status(400).json({ ok: false, error: 'date_invalid' });
  }
  const orders = await dayOrders(date);
  const closed = await get(
    'SELECT closed_at, orders_count, total_cents FROM daily_reports WHERE report_date = $1',
    date,
  );
  return res.json({
    ok: true,
    report: {
      date,
      closed_at: closed?.closed_at ?? null,
      closed_orders_count: closed?.orders_count ?? null,
      closed_total_cents: closed?.total_cents ?? null,
      orders,
      totals: totalsFor(orders),
    },
  });
});

// POST /api/admin/reports/:date/close — clôturer le rapport d'un
// jour (totaux figés). Idempotent : clôturer deux fois renvoie le
// rapport déjà clôturé. Impossible de clôturer un jour futur ou
// sans commande.
reportsRouter.post('/reports/:date/close', async (req, res) => {
  const date = req.params.date;
  if (!isValidDate(date)) {
    return res.status(400).json({ ok: false, error: 'date_invalid' });
  }
  if (date > montrealToday()) {
    return res.status(400).json({ ok: false, error: 'date_future' });
  }
  const existing = await get(
    'SELECT closed_at, orders_count, total_cents FROM daily_reports WHERE report_date = $1',
    date,
  );
  if (existing?.closed_at) {
    const orders = await dayOrders(date);
    return res.json({
      ok: true,
      report: {
        date,
        closed_at: existing.closed_at,
        closed_orders_count: existing.orders_count,
        closed_total_cents: existing.total_cents,
        orders,
        totals: totalsFor(orders),
      },
    });
  }
  const orders = await dayOrders(date);
  if (orders.length === 0) {
    return res.status(400).json({ ok: false, error: 'report_empty' });
  }
  const totals = totalsFor(orders);
  const now = new Date().toISOString();
  await run(
    `INSERT INTO daily_reports (report_date, closed_at, orders_count, total_cents)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (report_date) DO UPDATE SET
       closed_at = EXCLUDED.closed_at,
       orders_count = EXCLUDED.orders_count,
       total_cents = EXCLUDED.total_cents`,
    date,
    now,
    totals.orders_count,
    totals.total_cents,
  );
  return res.json({
    ok: true,
    report: {
      date,
      closed_at: now,
      closed_orders_count: totals.orders_count,
      closed_total_cents: totals.total_cents,
      orders,
      totals,
    },
  });
});
