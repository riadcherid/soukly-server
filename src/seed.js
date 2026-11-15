// Migration du catalogue de l'appli web vers la base Postgres du serveur.
// Source : src/data/catalog.json (export fidèle de l'action `listcatalog`
// de l'artifact marche-epicerie, 2026-11-14 : 19 rayons, 67 produits).
// Idempotent : on peut le relancer, il remplace les données du catalogue.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, transaction, close } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'catalog.json'), 'utf8'),
);

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
    await db.run(
      `INSERT INTO products
         (id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         category_key = EXCLUDED.category_key, unit = EXCLUDED.unit,
         price_cents = EXCLUDED.price_cents, sold_by_weight = EXCLUDED.sold_by_weight,
         available = EXCLUDED.available, image_key = EXCLUDED.image_key`,
      p.id, p.name, p.description, p.category, p.unit, p.price_cents,
      p.sold_by_weight, p.available, p.image_key,
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

await close();
