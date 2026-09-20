-- Bulk-insert seed for Aiven free-tier MySQL.
-- Uses recursive CTE + INSERT...SELECT to bulk-load.
-- ~30 seconds on Aiven free tier vs ~10 min for row-by-row procedure.

SET cte_max_recursion_depth = 100000;

DROP TABLE IF EXISTS orders, products, users, logs;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  tier VARCHAR(32) NOT NULL,
  city VARCHAR(64),
  age INT,
  active BOOLEAN,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10,2),
  stock INT,
  category VARCHAR(64),
  in_stock BOOLEAN
);
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  product_id INT,
  qty INT,
  total DECIMAL(10,2),
  status VARCHAR(32),
  placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  level VARCHAR(16),
  message TEXT,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10k users
INSERT INTO users (email, name, tier, city, age, active)
WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 10000)
SELECT CONCAT('user', i, '@example.com'), CONCAT('User ', i),
       ELT(1 + (i MOD 3), 'free','pro','enterprise'),
       ELT(1 + (i MOD 10), 'NYC','LA','Chicago','Houston','Phoenix','SF','Seattle','Boston','Austin','Philly'),
       18 + (i MOD 60), (i MOD 5) <> 0
FROM seq;

-- 5k products
INSERT INTO products (sku, name, price, stock, category, in_stock)
WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 5000)
SELECT CONCAT('SKU-', i), CONCAT('Product ', i),
       ROUND(RAND()*500, 2), FLOOR(RAND()*1000),
       ELT(1 + (i MOD 5), 'electronics','books','clothing','home','toys'),
       (i MOD 10) <> 0
FROM seq;

-- 20k orders
INSERT INTO orders (user_id, product_id, qty, total, status)
WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 20000)
SELECT 1 + FLOOR(RAND()*9999), 1 + FLOOR(RAND()*4999),
       1 + FLOOR(RAND()*5), ROUND(RAND()*1000, 2),
       ELT(1 + (i MOD 4), 'pending','shipped','delivered','cancelled')
FROM seq;

-- 30k logs
INSERT INTO logs (level, message)
WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 30000)
SELECT ELT(1 + (i MOD 4), 'info','warn','error','debug'),
       CONCAT('log entry ', i)
FROM seq;

SELECT 'users' t, COUNT(*) c FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'logs', COUNT(*) FROM logs;
