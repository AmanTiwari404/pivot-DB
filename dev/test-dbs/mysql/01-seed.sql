-- ──────────────────────────────────────────────────────────────────────────────
-- MySQL seed for test-mysql-a
--
-- Runs the first time the container starts (docker-entrypoint-initdb.d hook).
-- Mirrors the Postgres fixture so PG↔MySQL migrations can be diffed easily.
--
-- Exercises:
--   • AUTO_INCREMENT primary keys
--   • Foreign keys (with ON DELETE actions)
--   • Self-referencing categories
--   • JSON columns
--   • DATETIME ON UPDATE
--   • DECIMAL precision
--   • TINYINT(1) booleans
-- ──────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- ── Schema ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  email       VARCHAR(255) UNIQUE NOT NULL,
  age         INT,
  city        VARCHAR(100),
  country     VARCHAR(100),
  zip         VARCHAR(20),
  lat         DECIMAL(10,8),
  lng         DECIMAL(11,8),
  is_active   TINYINT(1) DEFAULT 1,
  score       DECIMAL(5,2),
  preferences JSON,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE categories (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  name      VARCHAR(100) NOT NULL,
  parent_id INT,
  slug      VARCHAR(100) UNIQUE,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  category_id  INT,
  price        DECIMAL(10,2) NOT NULL,
  stock        INT DEFAULT 0,
  description  TEXT,
  specs        JSON,
  is_available TINYINT(1) DEFAULT 1,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE orders (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT,
  total            DECIMAL(10,2) NOT NULL,
  status           VARCHAR(50) DEFAULT 'pending',
  shipping_city    VARCHAR(100),
  shipping_country VARCHAR(100),
  notes            TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_items (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  order_id   INT,
  product_id INT,
  quantity   INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Data — bulk insert via a stored procedure ────────────────────────────────
-- MySQL has no generate_series, so we use a procedure for the row loops.

DELIMITER $$
CREATE PROCEDURE seed_data()
BEGIN
  DECLARE i INT DEFAULT 1;

  -- 10 categories with self-references
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

  -- 500 users
  WHILE i <= 500 DO
    INSERT INTO users (name, email, age, city, country, zip, lat, lng, is_active, score, preferences)
    VALUES (
      CONCAT('User ', i),
      CONCAT('user', i, '@test.com'),
      18 + (i % 62),
      ELT(1 + (i % 9), 'Delhi','Mumbai','London','NYC','Berlin','Tokyo','Paris','Sydney','Toronto'),
      ELT(1 + (i % 8), 'IN','UK','US','DE','JP','FR','AU','CA'),
      LPAD(10000 + i, 6, '0'),
      ROUND((RAND() - 0.5) * 180, 8),
      ROUND((RAND() - 0.5) * 360, 8),
      IF(i % 5 != 0, 1, 0),
      ROUND(RAND() * 100, 2),
      JSON_OBJECT(
        'theme', IF(i % 2 = 0, 'dark', 'light'),
        'lang',  ELT(1 + (i % 5), 'en','es','fr','de','ja')
      )
    );
    SET i = i + 1;
  END WHILE;

  -- 300 products
  SET i = 1;
  WHILE i <= 300 DO
    INSERT INTO products (name, category_id, price, stock, description, specs, is_available)
    VALUES (
      CONCAT('Product ', i),
      1 + (i % 10),
      ROUND(10 + RAND() * 990, 2),
      (i * 7) % 500,
      CONCAT('Description for product ', i),
      JSON_OBJECT(
        'weight',   ROUND(RAND() * 5, 2),
        'color',    ELT(1 + (i % 7), 'red','blue','green','black','white','silver','gold'),
        'material', ELT(1 + (i % 5), 'plastic','metal','wood','fabric','glass')
      ),
      IF(i % 10 != 0, 1, 0)
    );
    SET i = i + 1;
  END WHILE;

  -- 1000 orders
  SET i = 1;
  WHILE i <= 1000 DO
    INSERT INTO orders (user_id, total, status, shipping_city, shipping_country, notes)
    VALUES (
      1 + (i % 500),
      ROUND(10 + RAND() * 990, 2),
      ELT(1 + (i % 4), 'pending','shipped','delivered','cancelled'),
      ELT(1 + (i % 5), 'Delhi','Mumbai','London','NYC','Berlin'),
      ELT(1 + (i % 4), 'IN','UK','US','DE'),
      IF(i % 5 < 2, CONCAT('Order note ', i), NULL)
    );
    SET i = i + 1;
  END WHILE;

  -- 3000 order_items
  SET i = 1;
  WHILE i <= 3000 DO
    INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    VALUES (
      1 + (i % 1000),
      1 + (i % 300),
      1 + (i % 10),
      ROUND(5 + RAND() * 200, 2)
    );
    SET i = i + 1;
  END WHILE;
END$$
DELIMITER ;

CALL seed_data();
DROP PROCEDURE seed_data;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_users_email       ON users(email);
CREATE INDEX idx_users_country     ON users(country);
CREATE INDEX idx_orders_user_id    ON orders(user_id);
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_products_category ON products(category_id);

-- Grants for testuser — covers migration writes, CDC replication, and the
-- Monitor page's PROCESSLIST / Performance Schema reads.
--
-- NOTE: MySQL 8 refuses GRANT ... ON information_schema.* and ON
-- performance_schema.* (server-managed schemas) — both raise ERROR 1044.
-- The `PROCESS` global privilege already covers what the Monitor page reads
-- from performance_schema, and `information_schema` filters its rows to
-- objects the user already has SOME privilege on, so explicit grants there
-- are unnecessary.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE
  ON testdb.* TO 'testuser'@'%';
GRANT PROCESS, REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO 'testuser'@'%';
FLUSH PRIVILEGES;
