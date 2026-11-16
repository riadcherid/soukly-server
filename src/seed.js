// Migration du catalogue de l'appli web vers la base Postgres du serveur.
// Source : src/data/catalog.json (export fidèle de l'action `listcatalog`
// de l'artifact marche-epicerie, 2026-11-14 : 19 rayons, 67 produits).
// Idempotent : on peut le relancer, il remplace les données du catalogue.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, transaction, close, get } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'catalog.json'), 'utf8'),
);

// Remplit le catalogue depuis catalog.json (upsert : relançable sans risque).
// Ne touche pas aux commandes ni aux clients.
export async function seedCatalog() {
  await initSchema();

  await transaction(async (db) => {
    for (const c of catalog.categories) {
      await db.run(
        `INSERT INTO categories (key, label, sort) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, sort = EXCLUDED.sort`,
        c.key, c.label, c.sort,
      );
    }
    for (const p of catalog.products) {
      // Unité de prix dérivée du poids (au poids → 'lb', sinon 'piece').
      // On ne l'écrase jamais à la mise à jour : l'unité choisie à
      // l'inventaire du matin (ex. 'kg') survit à un nouveau seed.
      // Idem pour on_special (prix spécial), géré par l'admin.
      await db.run(
        `INSERT INTO products
           (id, name, description, category_key, unit, price_cents, sold_by_weight, price_unit, available, image_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description,
           category_key = EXCLUDED.category_key, unit = EXCLUDED.unit,
           price_cents = EXCLUDED.price_cents, sold_by_weight = EXCLUDED.sold_by_weight,
           available = EXCLUDED.available, image_key = EXCLUDED.image_key`,
        p.id, p.name, p.description, p.category, p.unit, p.price_cents,
        p.sold_by_weight, p.sold_by_weight ? 'lb' : 'piece', p.available, p.image_key,
      );
    }
    await db.run(
      `INSERT INTO inventory (id, date, note, updated_at) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
      catalog.inventory.date, catalog.inventory.note, catalog.inventory.updated_at,
    );
  });

  console.log(
    `Catalogue migré : ${catalog.categories.length} rayons, ${catalog.products.length} produits ` +
    `(${catalog.products.filter((p) => p.available).length} disponibles, ` +
    `${catalog.products.filter((p) => !p.available).length} à prixer à l'inventaire du matin).`,
  );
  return { categories: catalog.categories.length, products: catalog.products.length };
}

// Remplit le catalogue seulement s'il est vide (base toute neuve, ex. Render).
// On ne réécrit jamais un catalogue déjà rempli : les prix fixés à
// l'inventaire du matin ne doivent pas être écrasés à chaque redémarrage.
export async function seedCatalogIfEmpty() {
  const row = await get('SELECT COUNT(*)::int AS count FROM products');
  if (row && row.count > 0) return { seeded: false, products: row.count };
  const result = await seedCatalog();
  return { seeded: true, ...result };
}

// Ligne de commande : `npm run seed` (remplit toujours, upsert).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seedCatalog();
  await close();
}
