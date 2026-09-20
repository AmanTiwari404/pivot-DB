# Local test fixtures — 9-direction migration suite

These containers are for **local development only**. They are not referenced by
the production `docker-compose.yml` and don't ship to Coolify.

## Layout

Six containers, paired A/B per engine. The **A** side is seeded with realistic
data and serves as a migration **source**; the **B** side starts empty and is
the **destination**. That way every one of the 9 migration directions has both
endpoints ready without re-seeding.

| Container         | Port  | Role        | Seeded |
|-------------------|-------|-------------|--------|
| `test-mongodb-a`  | 27018 | source      | ✅ ~5300 docs |
| `test-mongodb-b`  | 27019 | destination | — |
| `test-postgres-a` | 5433  | source      | ✅ ~4810 rows + pg_stat_statements |
| `test-postgres-b` | 5434  | destination | — |
| `test-mysql-a`    | 3307  | source      | ✅ ~4810 rows |
| `test-mysql-b`    | 3308  | destination | — |

All credentials: `testuser` / `testpass123`.

## Start

```bash
cd dev/test-dbs
docker compose up -d
```

First boot runs the seed files automatically:

- `mongo/01-seed.js` — 500 users, 300 products, 1000 orders, 2000 logs, 1500 analytics
- `postgres/01-seed.sql` — 500 users, 10 categories, 300 products, 1000 orders, 3000 order_items
- `mysql/01-seed.sql` — same schema as Postgres

## Connection strings (paste into the app's Add-Connection modal)

| Connection name to use in the app | URI |
|---|---|
| **MongoDB A** (source)  | `mongodb://testuser:testpass123@localhost:27018/testdb?authSource=admin` |
| **MongoDB B** (dest)    | `mongodb://testuser:testpass123@localhost:27019/testdb?authSource=admin` |
| **Postgres A** (source) | `postgresql://testuser:testpass123@localhost:5433/testdb` |
| **Postgres B** (dest)   | `postgresql://testuser:testpass123@localhost:5434/testdb` |
| **MySQL A** (source)    | `mysql://testuser:testpass123@localhost:3307/testdb` |
| **MySQL B** (dest)      | `mysql://testuser:testpass123@localhost:3308/testdb` |

> Ports are deliberately non-default to avoid colliding with the app's own
> metadata Postgres on `5432` or any host-installed MySQL on `3306`.

## What's in them

Equivalent schemas across all three engines, designed to exercise:

| Feature | Where |
|---|---|
| Foreign keys + ON DELETE actions | PG/MySQL `orders → users`, `order_items → orders/products` |
| Self-referencing PK | PG/MySQL `categories.parent_id → categories.id` |
| Nested objects | Mongo `users.address.geo`, `orders.shippingAddress` |
| Arrays of objects | Mongo `orders.items`, `products.ratings` |
| JSONB / JSON columns | PG `preferences`, `specs`; MySQL `preferences`, `specs` |
| TEXT[] arrays | PG `users.tags` |
| Mixed-type field | Mongo `users.age` — 5% are stored as string |
| Sparse fields | Mongo `users.score` / `users.tags` — 10% missing |
| Nullable columns | PG/MySQL `orders.notes` — 40% null |
| Decimal precision | PG/MySQL `lat`/`lng` DECIMAL(10,8)/(11,8), `total` DECIMAL(10,2) |
| TINYINT(1) bools | MySQL `is_active`, `is_available` |
| TIMESTAMPTZ vs DATETIME | PG vs MySQL |
| SERIAL vs AUTO_INCREMENT | PG vs MySQL primary keys |

## CDC sync setup (Phase 4)

The Postgres containers run with `wal_level=logical`, and the MySQL containers
run with `binlog_format=ROW`. The Postgres seed grants the `testuser` the
`REPLICATION` attribute; the MySQL seed grants `REPLICATION SLAVE` +
`REPLICATION CLIENT`. **You can use either A or B as a CDC source.**

Mongo containers are **standalone, not replica sets**. They're enough for the
9 migration directions (migrations only need cursors), but `db.watch()` change
streams won't work against them. To test Mongo source CDC, use Atlas or convert
a container to a single-node replica set manually.

## Manual one-time admin (after `up`)

```bash
# Verify seed counts
docker exec test-mongodb-a mongosh -u testuser -p testpass123 --authenticationDatabase admin \
  --quiet --eval 'use testdb; print(db.users.countDocuments())'
docker exec test-postgres-a psql -U testuser -d testdb -c "SELECT count(*) FROM users;"
docker exec test-mysql-a mysql -u testuser -ptestpass123 testdb -e "SELECT count(*) FROM users;"
```

## Stop / reset

```bash
docker compose down          # keep data
docker compose down -v       # wipe volumes — next start re-seeds
```

Running `down -v` is the easiest way to re-run the seeds; otherwise the
`/docker-entrypoint-initdb.d/` hooks only fire on a virgin data volume.
