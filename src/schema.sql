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

-- Évolutions v0.5.7 (idempotentes, rejouées à chaque démarrage) :
-- profil client enrichi pour l'écran « Mon compte » : photo de profil,
-- description (bio), adresse de livraison par défaut + code postal.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS photo_key TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- Évolutions v0.6.1 (idempotentes, rejouées à chaque démarrage) :
-- consigne sur les boissons en bouteille plastique ou en canette :
-- 0,10 $ par contenant (confirmé par Riad, reçu Épilys 16 nov. 2026
-- 18h32 : Hamoud Selecto 1 L, 2 × 0,10 $ = 0,20 $). La consigne est
-- stockée par produit (deposit_cents : 10 pour une bouteille/canette,
-- 120 pour un paquet de 12) et par commande (somme sur les articles
-- reçus) ; elle n'est JAMAIS taxée (ni TPS ni TVQ).
-- Le remplissage initial ne touche que les valeurs jamais définies
-- (deposit_cents IS NULL) : une consigne modifiée par l'admin survit
-- aux redémarrages, comme price_unit / on_special survivent au seed.
ALTER TABLE products ADD COLUMN IF NOT EXISTS deposit_cents INTEGER;
UPDATE products SET deposit_cents = 10 WHERE id = 18 AND deposit_cents IS NULL;
UPDATE products SET deposit_cents = 120 WHERE id = 20 AND deposit_cents IS NULL;
UPDATE products SET deposit_cents = 10 WHERE id = 48 AND deposit_cents IS NULL;
UPDATE products SET deposit_cents = 0 WHERE deposit_cents IS NULL;
ALTER TABLE products ALTER COLUMN deposit_cents SET DEFAULT 0;
ALTER TABLE products ALTER COLUMN deposit_cents SET NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_cents INTEGER NOT NULL DEFAULT 0;

-- Évolutions v0.6.0 (idempotentes, rejouées à chaque démarrage) :
-- vérification par e-mail (code à 6 chiffres) à l'inscription et à
-- chaque connexion : seul le hash SHA-256 du code est stocké, jamais
-- le code en clair ; code valable 10 minutes, usage unique, 5 essais
-- max, puis invalidé. Un nouveau code invalide les anciens non utilisés
-- (même e-mail + même but).
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evc_email_purpose_created
  ON email_verification_codes (email, purpose, created_at);

-- Évolutions v0.7.0 (idempotentes, rejouées à chaque démarrage) :
-- espace Livreur (troisième espace de l'appli, avec Admin et Client) :
-- comptes livreurs créés par l'admin (nom d'utilisateur + mot de
-- passe, haché bcrypt — pas de vérification par e-mail, l'admin les
-- crée) ; statut « en_livraison » (livreur en route) sur les commandes ;
-- assignation d'un livreur à une commande ; dernière position connue
-- du livreur par commande (une seule ligne par commande, mise à jour
-- à chaque envoi — la position n'est partagée que pendant la livraison).
CREATE TABLE IF NOT EXISTS couriers (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courier_positions (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  courier_id INTEGER NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_id INTEGER REFERENCES couriers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier_id);

-- Évolutions v0.7.3 (idempotentes, rejouées à chaque démarrage) :
-- photo de dépôt du livreur (preuve quand le client ne donne pas le
-- code : le livreur dépose la commande devant la porte, prend une
-- photo et part — sans attendre) : clé de la photo de dépôt sur la
-- commande.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dropoff_photo_key TEXT;

-- Évolutions v0.7.6 (idempotentes, rejouées à chaque démarrage) :
-- rapport du jour : numéro de commande par jour (le compteur repart
-- à 1 chaque jour, fuseau de Montréal) + clôture du rapport en fin
-- de journée.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS daily_number INTEGER;
CREATE TABLE IF NOT EXISTS daily_reports (
  report_date TEXT PRIMARY KEY,
  closed_at TEXT,
  orders_count INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0
);
-- Remplissage du numéro du jour pour les commandes existantes
-- (numérotation par jour de Montréal, dans l'ordre de création).
DO $$
BEGIN
  UPDATE orders o
     SET daily_number = sub.rn
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY (created_at::timestamptz AT TIME ZONE 'America/Toronto')::date
               ORDER BY created_at, id
             ) AS rn
        FROM orders
    ) sub
   WHERE o.id = sub.id AND o.daily_number IS NULL;
END $$;

-- Notifications push FCM (v0.7.4) : jetons d'appareil par
-- destinataire (client / livreur / admin). Un même jeton peut
-- appartenir à plusieurs destinataires à la fois (v0.7.5).
CREATE TABLE IF NOT EXISTS device_tokens (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('client', 'courier', 'admin')),
  owner_id INTEGER,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Migration v0.7.5 : remplacer l'unicité sur `token` seul par
-- l'unicité sur (token, owner_type, owner_id). NULLS NOT DISTINCT
-- pour que deux lignes admin (owner_id NULL) du même jeton
-- comptent comme doublon (Postgres 15+).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_tokens_token_key'
  ) THEN
    ALTER TABLE device_tokens DROP CONSTRAINT device_tokens_token_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'device_tokens_token_owner_key'
  ) THEN
    ALTER TABLE device_tokens
      ADD CONSTRAINT device_tokens_token_owner_key
      UNIQUE NULLS NOT DISTINCT (token, owner_type, owner_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_device_tokens_owner
  ON device_tokens (owner_type, owner_id);

-- Migration v0.7.10 : son de notification choisi par jeton
-- ('default' | 'long' | 'alarme') — idempotente : la colonne et la
-- contrainte sont ajoutées seulement si elles manquent.
ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS sound TEXT NOT NULL DEFAULT 'default';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_tokens_sound_check'
  ) THEN
    ALTER TABLE device_tokens
      ADD CONSTRAINT device_tokens_sound_check
      CHECK (sound IN ('default', 'long', 'alarme'));
  END IF;
END $$;

-- Évolution v0.7.12 (idempotente) : détaxation par produit
-- (`tax_exempt`) — le café (grains et moulu) est détaxé par décision
-- de Riad (2026-11-19), même si son rayon Boissons est taxable ;
-- le jus Ifruit reste taxé. La taxe reste décidée par rayon par
-- défaut ; le flag ne fait que l'annuler produit par produit.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
