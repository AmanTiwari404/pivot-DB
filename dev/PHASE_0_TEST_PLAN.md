# Phase 0 — Local verification checklist

Run this once Docker Desktop is up. Phase 0 changes are **additive** — existing
Mongo flows must continue working unchanged, and three new dbType slots must
become available.

## Prereqs

1. Docker Desktop running.
2. Repo at the Phase-0 commit.

## 1. Apply the Prisma migration

```bash
cd apps/api

# Start the app's metadata Postgres (port 5432).
docker compose -f ../../docker-compose.yml up -d postgres redis

# Generate the SQL for the new dbType / metadata / dbVersion columns and apply.
pnpm exec prisma migrate dev --name add_dbtype_metadata
```

**Expected:**

- Migration named `add_dbtype_metadata` created under `prisma/migrations/`.
- All existing `Connection` rows backfill `dbType='mongodb'`, `metadata=NULL`,
  `dbVersion=NULL` (the column defaults handle this — no manual SQL).
- `pnpm exec prisma studio` opens; the `Connection` model now shows the three
  new columns.

## 2. Start the test fixtures

```bash
cd ../../dev/test-dbs
docker compose up -d

# Both should report (healthy) within ~30s
docker compose ps
```

**Expected:** `mongovis-pg-test` on `5433` and `mongovis-mysql-test` on `3307`.

## 3. Start the app

```bash
# Back at repo root
cd ../..

# API
cd apps/api && pnpm dev &
# Web (in a new terminal)
cd apps/web && pnpm dev
```

Log in at <http://localhost:5173> with your existing superadmin account.

## 4. Smoke-test each engine

For each of the three engines below: click **Add Connection**, pick the engine,
paste the URI, save, then click **Test** on the resulting card.

### a) Existing MongoDB connection still works

- Open any pre-existing Mongo connection card.
- The pill row now shows **Mongo** (green) + the original topology pill.
- Click **Test** → returns latency + version.
- ✅ **Regression check:** nothing about Mongo flow should feel different.

### b) New Postgres connection

- Add Connection → **PostgreSQL**.
- Name: `Local PG Test`
- URI: `postgresql://test:test@localhost:5433/testdb`
- Save → row appears with **Postgres** badge (blue).
- Click **Test** → "Postgres v16.x · …ms".

### c) New MySQL connection

- Add Connection → **MySQL**.
- Name: `Local MySQL Test`
- URI: `mysql://test:test@localhost:3307/testdb`
- Save → row appears with **MySQL** badge (amber).
- Click **Test** → "MySQL v8.x · …ms".

## 5. Smoke-test the new discovery endpoints

There's no UI for these yet — Phase 1 builds the Migrate wizard that consumes
them. Use `curl` (replace `$TOKEN` with the JWT from localStorage `mv:token`
and `$ID` with each connection's id):

```bash
# List databases
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/connections/$ID/databases

# Discover schema
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/connections/$ID/schema
```

**Expected payloads (abbreviated):**

```jsonc
// Postgres
{
  "dbType": "postgres",
  "namespaces": [
    {
      "database": "public",
      "name": "users",
      "approxCount": 3,
      "columns": [
        { "name": "id", "type": "int", "nullable": false, "primaryKey": true },
        { "name": "email", "type": "string", "nullable": false },
        { "name": "metadata", "type": "jsonb", "nullable": true },
        { "name": "tags", "type": "string[]", "nullable": true }
      ]
    },
    { "database": "public", "name": "orders", "columns": [
      { "name": "id", "type": "int", "primaryKey": true, "nullable": false },
      { "name": "user_id", "type": "int", "nullable": false, "references": "public.users.id" }
    ]}
  ]
}
```

```jsonc
// MySQL
{
  "dbType": "mysql",
  "namespaces": [
    { "database": "testdb", "name": "users", "columns": [
      { "name": "is_active", "type": "boolean", "nullable": false }, // tinyint(1) → boolean
      { "name": "metadata",  "type": "json",    "nullable": true }
    ]}
  ]
}
```

```jsonc
// MongoDB (existing connection)
{
  "dbType": "mongodb",
  "namespaces": [
    { "database": "mydb", "name": "users", "approxCount": 1234, "columns": [
      { "name": "_id",     "type": "objectid", "primaryKey": true, "nullable": false },
      { "name": "address", "type": "object",   "nullable": true  },
      { "name": "age",     "type": "mixed",    "observedTypes": ["int","string"] }
    ]}
  ]
}
```

## 6. Regression checks (the boring but critical ones)

- [ ] Login still works.
- [ ] Existing Mongo connections still appear with **Mongo** badge.
- [ ] Existing backup jobs still fire (cron timezone respected).
- [ ] Monitor page still loads cluster details.
- [ ] No new errors in `pnpm dev` logs at startup.

## Stop / cleanup

```bash
# Test DBs only
cd dev/test-dbs && docker compose down

# Full stack
cd ../.. && docker compose down
```

---

## What's NOT in Phase 0 (Phase 1 work)

- **Actual cross-engine migration** — no readers/writers/mappers yet.
- **Migrate wizard UI** — consumes `/schema` and `/databases` but isn't built.
- **DDL generation / preview** — Phase 1.
- **Live progress / checkpoints** — Phase 1.

Phase 0 is purely the foundation: connection model, drivers, client
abstraction, URI validation, schema discovery endpoints, and UI surface for
choosing the engine.
