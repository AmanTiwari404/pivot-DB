-- ──────────────────────────────────────────────────────────────────────────────
-- Postgres seed for test-postgres-a
--
-- Runs the first time the container starts (docker-entrypoint-initdb.d hook).
-- Creates 5 related tables with FKs and self-references, then bulk-inserts
-- ~4810 rows using generate_series. Designed to exercise:
--   • SERIAL primary keys
--   • Foreign keys (with ON DELETE actions)
--   • Self-referencing categories
--   • JSONB columns (preferences, specs)
--   • TEXT[] arrays
--   • TIMESTAMPTZ + DECIMAL precision
--   • Nullable columns (10–40% null in some places)
-- ──────────────────────────────────────────────────────────────────────────────

-- Extensions. pg_stat_statements is preloaded via the `shared_preload_libraries`
-- command flag, but creating it in the target DB makes its views queryable.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Grant the REPLICATION attribute so CDC sync can use logical replication.
ALTER USER testuser WITH REPLICATION;

-- ── Schema ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  email       VARCHAR(255) UNIQUE NOT NULL,
  age         INTEGER,
  city        VARCHAR(100),
  country     VARCHAR(100),
  zip         VARCHAR(20),
  lat         DECIMAL(10,8),
  lng         DECIMAL(11,8),
  is_active   BOOLEAN DEFAULT true,
  score       DECIMAL(5,2),
  preferences JSONB,
  tags        TEXT[],
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE categories (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(100) NOT NULL,
  parent_id INTEGER REFERENCES categories(id),
  slug      VARCHAR(100) UNIQUE
);

CREATE TABLE products (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  category_id  INTEGER REFERENCES categories(id),
  price        DECIMAL(10,2) NOT NULL,
  stock        INTEGER DEFAULT 0,
  description  TEXT,
  specs        JSONB,
  is_available BOOLEAN DEFAULT true,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE orders (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  total            DECIMAL(10,2) NOT NULL,
  status           VARCHAR(50) DEFAULT 'pending',
  shipping_city    VARCHAR(100),
  shipping_country VARCHAR(100),
  notes            TEXT,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity    INTEGER NOT NULL,
  unit_price  DECIMAL(10,2) NOT NULL
);

-- ── Data ──────────────────────────────────────────────────────────────────────

-- 500 users
INSERT INTO users (name, email, age, city, country, zip, lat, lng, is_active, score, preferences, tags)
SELECT
  'User ' || i,
  'user' || i || '@test.com',
  18 + (i % 62),
  (ARRAY['Delhi','Mumbai','London','NYC','Berlin','Tokyo','Paris','Sydney','Toronto'])[1 + (i % 9)],
  (ARRAY['IN','UK','US','DE','JP','FR','AU','CA'])[1 + (i % 8)],
  LPAD((10000 + i)::text, 6, '0'),
  ROUND(((random() - 0.5) * 180)::numeric, 8),
  ROUND(((random() - 0.5) * 360)::numeric, 8),
  (i % 5) <> 0,
  ROUND((random() * 100)::numeric, 2),
  jsonb_build_object(
    'theme', CASE WHEN i % 2 = 0 THEN 'dark' ELSE 'light' END,
    'lang',  (ARRAY['en','es','fr','de','ja'])[1 + (i % 5)]
  ),
  ARRAY['tag' || (i % 10), 'tag' || (i % 5)]
FROM generate_series(1, 500) AS i;

-- 10 categories with a self-referencing parent_id
INSERT INTO categories (name, parent_id, slug) VALUES
  ('Electronics', NULL, 'electronics'),
  ('Clothing',    NULL, 'clothing'),
  ('Books',       NULL, 'books'),
  ('Phones',      1,    'phones'),
  ('Laptops',     1,    'laptops'),
  ('Shirts',      2,    'shirts'),
  ('Pants',       2,    'pants'),
  ('Fiction',     3,    'fiction'),
  ('Non-Fiction', 3,    'non-fiction'),
  ('Smartphones', 4,    'smartphones');

-- 300 products
INSERT INTO products (name, category_id, price, stock, description, specs, is_available)
SELECT
  'Product ' || i,
  1 + (i % 10),
  ROUND((10 + random() * 990)::numeric, 2),
  (i * 7) % 500,
  'Description for product ' || i,
  jsonb_build_object(
    'weight',   ROUND((random() * 5)::numeric, 2),
    'color',    (ARRAY['red','blue','green','black','white','silver','gold'])[1 + (i % 7)],
    'material', (ARRAY['plastic','metal','wood','fabric','glass'])[1 + (i % 5)]
  ),
  (i % 10) <> 0
FROM generate_series(1, 300) AS i;

-- 1000 orders
INSERT INTO orders (user_id, total, status, shipping_city, shipping_country, notes)
SELECT
  1 + (i % 500),
  ROUND((10 + random() * 990)::numeric, 2),
  (ARRAY['pending','shipped','delivered','cancelled'])[1 + (i % 4)],
  (ARRAY['Delhi','Mumbai','London','NYC','Berlin'])[1 + (i % 5)],
  (ARRAY['IN','UK','US','DE'])[1 + (i % 4)],
  -- ~40% null for notes (matches the Mongo seed's nullability).
  CASE WHEN i % 5 < 2 THEN 'Order note ' || i ELSE NULL END
FROM generate_series(1, 1000) AS i;

-- 3000 order_items
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  1 + (i % 1000),
  1 + (i % 300),
  1 + (i % 10),
  ROUND((5 + random() * 200)::numeric, 2)
FROM generate_series(1, 3000) AS i;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_users_email       ON users(email);
CREATE INDEX idx_users_country     ON users(country);
CREATE INDEX idx_orders_user_id    ON orders(user_id);
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_products_category ON products(category_id);

-- Refresh planner stats so the Monitor cache-hit panel shows realistic numbers.
ANALYZE;
