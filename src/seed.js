// Migration du catalogue de l'appli web vers la base Postgres du serveur.
// Source : src/data/catalog.json (export fidèle de l'action `listcatalog`
// de l'artifact marche-epicerie, 2026-11-14 ; refonte des rayons v0.7.8 :
// 22 rayons, 67 produits — « Viandes et poissons » scindé en « Viandes
// halal », « Poulet », « Poissons », plus « Orientaux et Maghrébins »).
// Idempotent : on peut le relancer, il remplace les données du catalogue.
// Charge .env comme index.js : sans ça, `npm run seed` seul retombe sur
// le mot de passe par défaut de db.js et échoue en auth_failed.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, transaction, close, get, run } from './db.js';

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
      // Idem pour on_special (prix spécial), géré par l'admin, et pour
      // deposit_cents (consigne) : insérée à la création depuis
      // catalog.json, jamais écrasée ensuite.
      await db.run(
        `INSERT INTO products
           (id, name, description, category_key, unit, price_cents, sold_by_weight, price_unit, available, image_key, deposit_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description,
           category_key = EXCLUDED.category_key, unit = EXCLUDED.unit,
           price_cents = EXCLUDED.price_cents, sold_by_weight = EXCLUDED.sold_by_weight,
           available = EXCLUDED.available, image_key = EXCLUDED.image_key`,
        p.id, p.name, p.description, p.category, p.unit, p.price_cents,
        p.sold_by_weight, p.sold_by_weight ? 'lb' : 'piece', p.available, p.image_key,
        Math.max(0, Math.floor(Number(p.deposit_cents) || 0)),
      );
    }
    await db.run(
      `INSERT INTO inventory (id, date, note, updated_at) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
      catalog.inventory.date, catalog.inventory.note, catalog.inventory.updated_at,
    );
    // Le rayon fusionné « viandes-poissons » a disparu du catalogue
    // (v0.7.8) : une fois ses produits réassignés, on le retire.
    await db.run(
      `DELETE FROM categories WHERE key = 'viandes-poissons'
       AND NOT EXISTS (SELECT 1 FROM products WHERE category_key = 'viandes-poissons')`,
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

// Migration des rayons (v0.7.8, une seule fois) : « Viandes et
// poissons » est scindé en « Viandes halal », « Poulet », « Poissons »,
// et « Orientaux et Maghrébins » est ajouté. Appelé à chaque
// démarrage, mais il ne fait quelque chose que si le rayon fusionné
// existe encore en base : après la migration, les renommages faits
// par l'admin dans l'appli ne sont plus jamais écrasés. Ne touche
// ni aux prix, ni aux dispos, ni aux produits hors du rayon fusionné
// (un produit que l'admin a déjà déplacé ailleurs reste où il est).
export async function syncCatalogCategories() {
  const legacy = await get(
    "SELECT key FROM categories WHERE key = 'viandes-poissons'",
  );
  if (!legacy) return { migrated: false };
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  await transaction(async (db) => {
    for (const c of catalog.categories) {
      await db.run(
        `INSERT INTO categories (key, label, sort) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, sort = EXCLUDED.sort`,
        c.key, c.label, c.sort,
      );
    }
    const rows = await db.all(
      "SELECT id FROM products WHERE category_key = 'viandes-poissons'",
    );
    for (const row of rows) {
      const target = byId.get(row.id);
      if (target) {
        await db.run(
          'UPDATE products SET category_key = $1 WHERE id = $2',
          target.category, row.id,
        );
      }
    }
    await db.run(
      `DELETE FROM categories WHERE key = 'viandes-poissons'
       AND NOT EXISTS (SELECT 1 FROM products WHERE category_key = 'viandes-poissons')`,
    );
  });
  console.log(
    'Rayons migrés : « Viandes et poissons » scindé en « Viandes halal », « Poulet », « Poissons » + « Orientaux et Maghrébins ».',
  );
  return { migrated: true };
}

// Synchronise les photos des produits depuis catalog.json : remplit
// image_key seulement quand il est vide (NULL) en base. Ne touche
// jamais aux prix, aux dispos, ni à une photo déjà définie (une vraie
// photo d'Épilys remplacera plus tard la photo générée par IA via
// l'appli admin). Appelé à chaque démarrage : c'est ce qui met en
// ligne les nouvelles photos après un déploiement, sans réécrire le
// catalogue rempli.
export async function syncProductImages() {
  let updated = 0;
  for (const p of catalog.products) {
    if (!p.image_key) continue;
    const result = await run(
      'UPDATE products SET image_key = $1 WHERE id = $2 AND image_key IS NULL',
      p.image_key, p.id,
    );
    updated += result.rowCount;
  }
  if (updated > 0) {
    console.log(`Photos synchronisées : ${updated} produit(s) avec photo ajoutée.`);
  }
  return { updated };
}

// Ligne de commande : `npm run seed` (remplit toujours, upsert).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seedCatalog();
  await close();
}
