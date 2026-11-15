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
