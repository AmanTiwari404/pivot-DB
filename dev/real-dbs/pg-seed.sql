DROP TABLE IF EXISTS orders, products, users, logs CASCADE;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  city TEXT,
  age INT,
  active BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price NUMERIC(10,2),
  stock INT,
  category TEXT,
  in_stock BOOLEAN
);
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  product_id INT REFERENCES products(id),
  qty INT,
  total NUMERIC(10,2),
  status TEXT,
  placed_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  level TEXT,
  message TEXT,
  ts TIMESTAMPTZ DEFAULT now()
);

-- 10k users
INSERT INTO users (email, name, tier, city, age, active)
SELECT 'user'||i||'@example.com', 'User '||i,
       (ARRAY['free','pro','enterprise'])[1 + (i % 3)],
       (ARRAY['NYC','LA','Chicago','Houston','Phoenix','SF','Seattle','Boston','Austin','Philly'])[1 + (i % 10)],
       18 + (i % 60),
       (i % 5) <> 0
FROM generate_series(1, 10000) i;

-- 5k products
INSERT INTO products (sku, name, price, stock, category, in_stock)
SELECT 'SKU-'||i, 'Product '||i,
       round((random()*500)::numeric, 2),
       (random()*1000)::int,
       (ARRAY['electronics','books','clothing','home','toys'])[1 + (i % 5)],
       (i % 10) <> 0
FROM generate_series(1, 5000) i;

-- 20k orders
INSERT INTO orders (user_id, product_id, qty, total, status)
SELECT 1 + (random()*9999)::int,
       1 + (random()*4999)::int,
       1 + (random()*5)::int,
       round((random()*1000)::numeric, 2),
       (ARRAY['pending','shipped','delivered','cancelled'])[1 + (i % 4)]
FROM generate_series(1, 20000) i;

-- 30k logs
INSERT INTO logs (level, message)
SELECT (ARRAY['info','warn','error','debug'])[1 + (i % 4)],
       'log entry '||i
FROM generate_series(1, 30000) i;

SELECT 'users' AS t, count(*) FROM users
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'logs', count(*) FROM logs;