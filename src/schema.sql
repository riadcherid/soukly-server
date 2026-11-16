-- Schéma Soukly — serveur API mobile (Postgres 16).
-- Les prix sont en cents, les poids en grammes.

CREATE TABLE IF NOT EXISTS categories (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_key TEXT NOT NULL REFERENCES categories(key),
  unit TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  sold_by_weight BOOLEAN NOT NULL DEFAULT FALSE,
  available BOOLEAN NOT NULL DEFAULT FALSE,
  image_key TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_email TEXT UNIQUE,
  auth_provider TEXT NOT NULL DEFAULT 'password',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recue',
  address TEXT,
  postal_code TEXT,
  phone TEXT,
  note TEXT,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  service_fee_cents INTEGER NOT NULL DEFAULT 0,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  delivery_zone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  weight_grams INTEGER,
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'a_collecter',
  collected_weight_grams INTEGER
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  date TEXT,
  note TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_key);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Évolutions v0.3.0 (idempotentes, rejouées à chaque démarrage) :
-- comptes Google/Apple sans téléphone ; totaux estimé/final des commandes ;
-- produit de remplacement pour un article manquant.
ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS apple_sub TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_total_cents INTEGER;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS replacement_product_id INTEGER REFERENCES products(id);

-- Évolutions v0.5.2 (idempotentes, rejouées à chaque démarrage) :
-- taxes TPS/TVQ stockées sur la commande ; indicateur « préparé »
-- (fast-food) sur le produit, taxable TPS + TVQ.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tps_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tvq_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS prepared BOOLEAN NOT NULL DEFAULT FALSE;

-- Évolutions v0.5.3 (idempotentes, rejouées à chaque démarrage) :
-- e-mail du client (obligatoire à l'inscription, nullable pour les
-- comptes existants) et horodatage d'envoi du reçu par e-mail.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_email_sent_at TEXT;

-- Évolutions v0.5.4 (idempotentes, rejouées à chaque démarrage) :
-- unité de prix flexible par produit ('piece' | 'lb' | 'kg') et prix
-- spécial (rayon Promotions). Les produits existants gardent leur unité
-- actuelle (au poids → 'lb', à l'unité → 'piece'), aucun prix ne change.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_unit TEXT;
UPDATE products SET price_unit = CASE WHEN sold_by_weight THEN 'lb' ELSE 'piece' END WHERE price_unit IS NULL;
ALTER TABLE products ALTER COLUMN price_unit SET DEFAULT 'piece';
ALTER TABLE products ALTER COLUMN price_unit SET NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS on_special BOOLEAN NOT NULL DEFAULT FALSE;

-- Évolutions v0.5.5 (idempotentes, rejouées à chaque démarrage) :
-- nom d'utilisateur du client (obligatoire à l'inscription, unique,
-- insensible à la casse : stocké en minuscules). Les comptes existants
-- n'en ont pas : ils peuvent en ajouter un via PATCH /api/auth/me.
-- Le nom complet devient facultatif à l'inscription : l'affichage
-- retombe sur le nom d'utilisateur quand il est absent.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE customers ALTER COLUMN name DROP NOT NULL;

-- Évolutions v0.5.6 (idempotentes, rejouées à chaque démarrage) :
-- code de livraison aléatoire à 6 chiffres (100000–999999) sur chaque
-- commande, unique entre les commandes en cours : le livreur le compare
-- avec le code du bon à la remise du sac (style Uber Eats). Affichage
-- seulement, aucune vérification serveur. Les commandes existantes
-- (ex. la commande n° 4 de Riad en ligne) en reçoivent un à la migration.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_code TEXT;
DO $$
DECLARE
  r RECORD;
  c TEXT;
  done BOOLEAN;
BEGIN
  FOR r IN SELECT id FROM orders WHERE delivery_code IS NULL ORDER BY id LOOP
    done := FALSE;
    WHILE NOT done LOOP
      c := (100000 + floor(random() * 900000))::TEXT;
      UPDATE orders SET delivery_code = c
      WHERE id = r.id
        AND NOT EXISTS (
          SELECT 1 FROM orders o2
          WHERE o2.delivery_code = c AND o2.id <> r.id
            AND o2.status NOT IN ('terminee', 'annulee')
        );
      IF FOUND THEN done := TRUE; END IF;
    END LOOP;
  END LOOP;
END $$;
ALTER TABLE orders ALTER COLUMN delivery_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_delivery_code_active
  ON orders (delivery_code) WHERE status NOT IN ('terminee', 'annulee');
