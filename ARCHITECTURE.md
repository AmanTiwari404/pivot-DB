# PivotDB — Architecture & Internals

A complete walkthrough of what this project is, what it is built with, how the
pieces fit together, and how each subsystem works internally.

> **Scope note:** this document describes the code as it exists in this
> repository. Where the implementation is incomplete or differs from the
> README, it is called out explicitly in
> [§15 Known gaps](#15-known-gaps-and-caveats-found-in-the-code).

---

## Table of contents

1. [What PivotDB is](#1-what-pivotdb-is)
2. [Technology stack](#2-technology-stack)
3. [Repository layout](#3-repository-layout)
4. [Runtime topology](#4-runtime-topology)
5. [Request lifecycle](#5-request-lifecycle)
6. [Data model](#6-data-model-the-metadata-database)
7. [Security model](#7-security-model)
8. [The engine abstraction](#8-the-engine-abstraction-dbclient)
9. [Migrate — the cross-engine pipeline](#9-migrate--the-cross-engine-pipeline)
10. [Sync — change data capture](#10-sync--change-data-capture-cdc)
11. [Protect — backup and restore](#11-protect--backup-and-restore)
12. [Monitor, metrics and alerts](#12-monitor-metrics-and-alerts)
13. [Background jobs and scheduling](#13-background-jobs-and-scheduling)
14. [Frontend architecture](#14-frontend-architecture)
15. [Known gaps and caveats](#15-known-gaps-and-caveats-found-in-the-code)
16. [How to extend it](#16-how-to-extend-it)
17. [Local development](#17-local-development-on-this-machine)

---

## 1. What PivotDB is

PivotDB is a **self-hostable, multi-engine data platform**. It puts one web
console in front of MongoDB, PostgreSQL and MySQL and lets you:

| Capability | What it actually does |
|---|---|
| **Connections** | Store database URIs encrypted at rest, probe them for version/latency/topology |
| **Explore** | Browse schemas, page through rows/documents, run queries and aggregations |
| **Migrate** | Stream a full copy between any two of the three engines (9 directions), inferring and translating schema on the way |
| **Move** | Legacy MongoDB-only copy driven by `mongodump`/`mongorestore` |
| **Sync** | Continuous change-data-capture replication — snapshot, then tail the source's change log forever |
| **Protect** | Scheduled encrypted backups using native dump tools, plus restore-to-any-target |
| **Monitor** | Live server stats, current operations, slow queries, plus Grafana dashboards |
| **Alerts** | Threshold rules with duration debounce, notifying by email or webhook |

The central design idea is that **every engine hides behind a small set of
interfaces** (`DbClient`, `NamespaceReader`, `NamespaceWriter`, `RecordMapper`,
`CdcSource`). Adding a fourth engine is a matter of implementing those
interfaces rather than touching feature code.

---

## 2. Technology stack

### 2.1 Backend — `apps/api`

| Layer | Choice | Why / notes |
|---|---|---|
| Runtime | **Node.js 20+**, native ESM | `"type": "module"`; imports use `.js` specifiers even in `.ts` source |
| Language | **TypeScript 5.5** | `tsx watch` in dev, `tsc` → `dist/` for production |
| HTTP server | **Fastify 4** | Plugin architecture, schema-based serialisation |
| Plugins | `@fastify/cors`, `@fastify/helmet`, `@fastify/jwt`, `fastify-plugin` | Helmet runs with CSP disabled so the Grafana iframe works |
| Realtime | **Socket.IO 4** | Attached to Fastify's underlying HTTP server |
| ORM | **Prisma 5** | Metadata DB only — never used for user databases |
| Metadata store | **PostgreSQL 16** | Connections, jobs, runs, rules, audit |
| Queue | **BullMQ 5** on **Redis 7** | `ioredis` pinned to `5.10.1` via a pnpm override |
| Validation | **Zod 3** | Request body parsing at route boundaries |
| Auth | `@fastify/jwt` + **bcryptjs** | 7-day HS256 tokens |
| Metrics | **prom-client 15** | Two registries, exposed at `/metrics` |
| Scheduling | **node-cron** + BullMQ repeatables | See §13 |
| Email / webhooks | **nodemailer 8**, `fetch` | Alert notification channels |
| Archiving | `tar`, `archiver`, `node:zlib`, `node:crypto` | Backup pipeline |
| Object storage | `@aws-sdk/client-s3` + `lib-storage` | `lib/s3.ts`, `lib/r2.ts` scaffolding |

**Database drivers** — the part that makes this a multi-engine tool:

| Driver | Used for |
|---|---|
| `mongodb` 6 | Client, reader/writer, change streams |
| `pg` 8 | Client, reader/writer |
| `pg-copy-streams` | `COPY FROM STDIN` bulk loads (the fast path) |
| `pg-query-stream` | Server-side cursor reads |
| `pg-logical-replication` | Postgres CDC via the `pgoutput` plugin |
| `mysql2` 3 | Client, reader/writer |
| `@vlasky/zongji` | MySQL CDC by reading the binary log |
| `bson` 7 | Decimal128 / ObjectId handling during translation |

### 2.2 Frontend — `apps/web`

| Layer | Choice |
|---|---|
| Framework | **React 18** + **TypeScript** |
| Build | **Vite 5** with `@vitejs/plugin-react` |
| Routing | **react-router-dom 6** |
| Server state | **@tanstack/react-query 5** |
| Client state | **zustand 4** with `persist` |
| UI primitives | **Radix UI** (dialog, select, tabs, toast, tooltip, …) |
| Styling | **Tailwind CSS 3** + `tailwind-merge` + `class-variance-authority` |
| Icons | **lucide-react** |
| Query editor | **monaco-editor** + `@monaco-editor/react` |
| Charts | **recharts** |
| Schema graph | **@xyflow/react** (React Flow) |
| Realtime | **socket.io-client** |

### 2.3 Infrastructure

| Service | Image | Port | Role |
|---|---|---|---|
| postgres | `postgres:16-alpine` | 5432 | Metadata database |
| redis | `redis:7-alpine` | 6379 | BullMQ queue + repeatable schedules |
| prometheus | custom build | 9090 | Scrapes `/metrics` every 15s, 30-day retention |
| grafana | custom build | 3003→3000 | Provisioned dashboards per engine |
| api | custom build | 3001 | Fastify + all workers |
| web | custom build | 3002→80 | Nginx-served static bundle (production only) |

The API production image is notable: it installs **`mongodb-database-tools`,
`postgresql-client-17` and `default-mysql-client`** because backup and restore
shell out to the *native* dump tools. `pg_dump` is pinned to v17 specifically
because it refuses to dump a server newer than itself, and managed Postgres
(Neon, RDS) now runs 17.

---

## 3. Repository layout

```
pivotDB-main/
├── apps/
│   ├── api/                      Fastify backend + all background workers
│   │   ├── prisma/
│   │   │   ├── schema.prisma     18 models — the metadata database
│   │   │   └── migrations/       Applied with `prisma migrate deploy`
│   │   └── src/
│   │       ├── index.ts          Composition root: plugins, routes, workers
│   │       ├── plugins/          auth (JWT), socketio
│   │       ├── routes/           HTTP surface, one file per feature
│   │       ├── services/         Feature logic (monitor, metrics, discovery…)
│   │       ├── lib/
│   │       │   ├── clients/      DbClient per engine — the core abstraction
│   │       │   ├── notifications/ email + webhook channels
│   │       │   ├── prisma.ts, redis.ts, queue.ts, mongo.ts
│   │       │   └── alertEvaluator.ts, uri-validators.ts
│   │       ├── migration/        The cross-engine engine (see §9, §10)
│   │       │   ├── types.ts      Reader/Mapper/Writer/CdcSource contracts
│   │       │   ├── pipeline.ts   The orchestrator
│   │       │   ├── service.ts    Engine-pair → (reader, writer, mapper)
│   │       │   ├── worker.ts     BullMQ worker for migration-v2
│   │       │   ├── readers/      mongo, postgres, mysql
│   │       │   ├── writers/      mongo, postgres, mysql
│   │       │   ├── mappers/      6 cross-engine + 1 identity
│   │       │   ├── ddl/          postgres + mysql DDL generation
│   │       │   ├── inference/    mongo schema sampler
│   │       │   └── cdc/          mongo, postgres, mysql change sources
│   │       ├── jobs/             BullMQ workers: backup, restore, export, cdc
│   │       ├── scheduler/        Cron + repeatable job registration
│   │       └── crypto/encrypt.ts AES-256-GCM for stored URIs
│   └── web/                      React console
│       └── src/
│           ├── App.tsx           Routes + auth guard
│           ├── pages/            One per nav item
│           ├── components/       shared, connections, explore, monitor, console
│           ├── lib/api.ts        Typed fetch wrapper (~500 lines)
│           ├── lib/socket.ts     Socket.IO connection cache
│           └── stores/           zustand: active connection, auth
├── config/
│   ├── prometheus/               Scrape config
│   └── grafana/                  Datasource + dashboards (mongodb/postgres/mysql)
├── dev/                          Seed data and test-database compose files
├── docker-compose.yml            Full stack
├── docker-compose.dev.yml        Dev overrides (bind mounts, exposed ports)
├── dev.sh                        One-command local launcher
└── decrypt-backup.mjs            Standalone tool to decrypt a backup archive
```

---

## 4. Runtime topology

### 4.1 Process model

The most important structural fact: **the API and every background worker run
in one Node.js process.** `apps/api/src/index.ts` registers the HTTP routes and
then starts six workers and the scheduler inline.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser — React SPA (Vite dev :5173 / Nginx :3002)          │
│    ├── REST over fetch, Bearer token from localStorage       │
│    ├── Socket.IO for live monitor + migration progress       │
│    └── <iframe> embedding Grafana panels                     │
└───────────────┬──────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────┐
│  Fastify API — single Node process, port 3001                │
│                                                               │
│  HTTP layer          Socket.IO             Workers (BullMQ)   │
│  ───────────         ──────────            ────────────────   │
│  /api/connections    /monitor/<connId>     migration-v2  (c=1)│
│  /api/.../explore    /migration-v2         cdc-sync      (c=5)│
│  /api/.../monitor                          backup             │
│  /api/migration-v2                         restore            │
│  /api/cdc-sync                             export             │
│  /api/backup                               migration (legacy) │
│  /api/alerts                                                  │
│  /api/settings/*                           Scheduler          │
│  /health/live|ready                        ─────────          │
│  /metrics                                  node-cron 30s      │
│                                            BullMQ repeatables │
└────┬─────────────┬─────────────┬──────────────────────────────┘
     │             │             │
     ▼             ▼             ▼
 PostgreSQL     Redis       User databases
 (metadata)    (queue)      (Mongo / PG / MySQL — the things you manage)
     ▲
     │ scrape /metrics every 15s
┌────┴────────┐        ┌──────────────┐
│ Prometheus  │◀───────│   Grafana    │ provisioned dashboards
│   :9090     │        │    :3003     │ one folder per engine
└─────────────┘        └──────────────┘
```

**Consequence of the single-process design:** a long migration streaming
millions of rows shares an event loop with the HTTP API. This is why
`migration-v2` runs at `concurrency: 1` and why the CDC worker caps at 5
concurrent streams. It keeps memory and outbound connection counts
predictable, at the cost of not being able to scale workers independently.

### 4.2 Two distinct database roles

Do not confuse them:

- **The metadata database** (PostgreSQL, accessed through Prisma) stores
  PivotDB's own state: users, connections, job definitions, run history.
- **User databases** are the MongoDB/PostgreSQL/MySQL servers you register as
  *Connections*. These are never touched by Prisma — only by the raw drivers
  through the `DbClient` / reader / writer layers.

---

## 5. Request lifecycle

Taking `GET /api/connections/:id/schema` as the example:

1. **Vite dev proxy** (dev only) forwards `/api/*` and `/socket.io` from
   `:5173` to `:3001`, so the browser sees a same-origin app and no CORS or
   `VITE_API_URL` configuration is needed.
2. **CORS + Helmet** run. CSP is disabled deliberately — the Monitor page
   embeds Grafana in an iframe.
3. **`preHandler: [app.authenticate]`** calls `request.jwtVerify()`. A failure
   short-circuits with `401`, and the frontend's fetch wrapper reacts by
   clearing the token and redirecting to `/login`.
4. **Profile scoping** — `profileScope(req)` returns `{}` for a superadmin or
   `{ profileId }` for everyone else. That object is spread into the Prisma
   `where` clause, which is how multi-tenancy is enforced.
5. **Handler** loads the `Connection` row, calls `decrypt(encryptedUri)`, and
   builds a single-use `DbClient` via `makeClient(dbType, uri)`.
6. **Engine work** happens behind the interface; the client is closed in a
   `finally`.
7. **`preSerialization` hook** walks the payload and converts every `BigInt`
   to a `Number`, because `BackupRun.sizeBytes` is a `BigInt` and JSON cannot
   serialise it natively.

---

## 6. Data model (the metadata database)

18 Prisma models. The spine is `Profile → Connection → {jobs} → {runs}`.

### 6.1 Tenancy and identity

| Model | Purpose |
|---|---|
| **Profile** | The tenant. Owns connections, jobs, rules. Has one `adminId`. |
| **User** | `email`, `passwordHash`, `role` (`superadmin` / `admin` / `viewer`), optional `profileId`. A superadmin has `profileId = null` and sees everything. |

### 6.2 Connections

```prisma
model Connection {
  id           String
  name         String
  encryptedUri String   // AES-256-GCM, never stored in plaintext
  dbType       String   // "mongodb" | "postgres" | "mysql"
  topology     String   // Mongo: standalone|replicaSet|sharded; SQL: standalone
  metadata     Json?    // per-engine extras (SSL CA, schema name, charset)
  dbVersion    String?  // cached at last successful probe
  readOnly     Boolean
  tags         String[]
  ...
}
```

`dbType` is the discriminator that drives client selection, discovery,
monitoring and backup strategy throughout the codebase.

### 6.3 Job / run pairs

Every long-running feature follows the same **definition + execution history**
shape, which is what makes the UI able to show "last run" state cheaply:

| Definition | Execution | Notes |
|---|---|---|
| `BackupJob` | `BackupRun` → `RestoreRun` | Cron schedule, retention |
| `MigrationJobV2` | `MigrationRunV2` | Cross-engine pipeline |
| `MigrationJob` | `MigrationRun` | Legacy Mongo-only `mongodump` path |
| `CdcSyncJob` | `CdcSyncRun` | Continuous — job outlives any single run |
| `ExportJob` | *(inline)* | CSV/JSON extraction |
| `AlertRule` | `AlertEvent` | Rule carries its own state machine |

Supporting models: `SavedQuery` (Explore), `AuditEvent` (settings audit log),
`JobRun` (generic).

### 6.4 The two most interesting models

**`MigrationJobV2`** caches `sourceType`/`destType` directly on the row so the
worker can route to the right reader/writer without joining `Connection` on
every batch. It also carries tuning knobs: `sampleSize`, `batchSize`,
`parallelism`, `dropExisting`, `failOnTypeConflict`.

**`CdcSyncJob`** carries the replication state machine:

| Field | Meaning |
|---|---|
| `cursor` | Opaque JSON resume position, owned by the engine adapter |
| `snapshotState` | `pending` \| `done` — deliberately **decoupled** from `cursor` |
| `status` | `queued` \| `bootstrapping` \| `tailing` \| `paused` \| `failed` |
| `pauseRequested` | Cooperative cancellation flag the worker polls |
| `bootstrap` | `snapshot` (full copy first) or `tail` (assume dest populated) |

The `snapshotState` / `cursor` split is subtle and important. The cursor is
saved **before** the snapshot starts (so the tail can replay everything that
changed during the copy). If they were one field, a crash mid-snapshot would
be indistinguishable from a completed one, and the worker would flip to
tailing against a half-copied destination.

---

## 7. Security model

### 7.1 Authentication

- **First-run setup.** `GET /api/connections/auth/status` returns
  `{ needsSetup: true }` while `User` count is zero. The SPA uses this to route
  to `/signup` instead of `/login`.
- **`POST .../auth/register`** succeeds **only** when zero users exist and
  creates the first `superadmin`. Afterwards it returns `403`; further accounts
  come from the profile/viewer invite endpoints.
- **`POST .../auth/login`** verifies a bcrypt hash, stamps `lastLoginAt`, and
  signs a JWT valid for **7 days** containing
  `{ userId, email, role, profileId }`.

> **Quirk worth knowing:** the auth routes live *inside* `connections.ts` and
> therefore sit under the `/api/connections` prefix — hence the slightly odd
> `/api/connections/auth/login`. They are functionally global, not
> connection-scoped.

### 7.2 Authorisation

Three roles, checked by helpers in `plugins/auth.ts`:

| Role | Scope |
|---|---|
| `superadmin` | All profiles. `profileScope()` returns `{}` (no filter). |
| `admin` | Own profile, full write access. |
| `viewer` | Own profile, blocked from writes by `requireAdmin()` → `403`. |

### 7.3 Encryption at rest

`crypto/encrypt.ts` — AES-256-GCM with a 12-byte random IV per value:

```
stored value = ivHex : authTagHex : ciphertextHex
```

The key is `ENCRYPTION_KEY`, required to be exactly 64 hex characters
(32 bytes). **Losing this key makes every stored connection URI
unrecoverable.**

Backup archives use a separate key, `BACKUP_ENCRYPTION_KEY`, and a different
on-disk layout (§11.2).

### 7.4 Transport

The frontend keeps the JWT in `localStorage` and attaches it as
`Authorization: Bearer …`. Socket.IO connections pass it in the handshake
`auth` field. Note that the Socket.IO server is configured with
`cors: { origin: '*' }`.

---

## 8. The engine abstraction (`DbClient`)

Every read-only console feature — connection testing, database listing, schema
discovery, row paging — goes through one interface in
`lib/clients/types.ts`:

```ts
export interface DbClient {
  readonly dbType: DbType;
  probe(): Promise<ProbeResult>;                      // version, latencyMs, topology
  listDatabases(): Promise<string[]>;
  discoverSchema(database?, opts?): Promise<DiscoveredNamespace[]>;
  fetchRows(namespace, { limit, offset }): Promise<RowPage>;
  close(): Promise<void>;
}
```

`makeClient(dbType, uri)` is the factory, and it uses a `never`-typed
exhaustiveness check so adding an engine to the `DbType` union produces a
compile error everywhere a switch must be updated.

The abstraction normalises vocabulary across engines:

| Concept | MongoDB | PostgreSQL | MySQL |
|---|---|---|---|
| `database` | database | **schema** | database |
| `namespace` | collection | table | table |
| `columns` | sampled fields | declared columns | declared columns |
| `topology` | standalone/replicaSet/sharded | always `standalone` | always `standalone` |

Clients are **single-use**: the caller owns `close()`. The one exception is
`lib/mongo.ts`, which keeps a `Map<connectionId, MongoClient>` pool for the
Monitor page, where a 3-second polling loop would otherwise reconnect
constantly. `closeAllClients()` drains it on shutdown.

---

## 9. Migrate — the cross-engine pipeline

This is the heart of the project. Source: `apps/api/src/migration/`.

### 9.1 The three roles

```
┌──────────┐  SourceRecord  ┌──────────┐  DestRecord  ┌──────────┐
│  Reader  │ ─────────────▶ │  Mapper  │ ───────────▶ │  Writer  │
└──────────┘                └──────────┘              └──────────┘
 server-side cursor          pure, synchronous         batched apply
 bounded memory              per-row transform         dialect-specific DDL
```

- **`NamespaceReader`** — `listNamespaces`, `inferSchema`, `countExact`,
  `read()` (an `AsyncIterable`), `close`. Implementations must use a
  server-side cursor so memory stays bounded.
- **`RecordMapper`** — `translateSchema` (source shape → destination shape),
  `mapRecord` (pure and synchronous, it is the hot path), `drainWarnings`.
- **`NamespaceWriter`** — `init` (DDL), `writeBatch`, `finalize`, `close`, and
  optionally `applyChange` for CDC.

Because the roles are separate, supporting N engines needs N readers, N
writers, and at most N²⁄2 mappers. The repo has 3 readers, 3 writers, 6
cross-engine mappers, and an `IdentityMapper` for same-engine pairs.

### 9.2 Canonical types — the lingua franca

Readers translate native types *into* this set; writers translate *out* of it.
Keeping it deliberately small is what stops the mapper matrix from exploding:

```
string · int · long · float · double · decimal · boolean
date · timestamp · time · binary · uuid · objectid
json · jsonb · array · mixed · null · unknown
```

The last three are the escape hatches. When Mongo sampling sees a field that
holds a string in some documents and a number in others, it becomes `mixed`,
the DDL generator widens it to `TEXT`/`JSONB`, and a `SchemaWarning` with code
`mixed_type_field` is surfaced in the UI *before* the run.

`InferredColumn.autoIncrement` is threaded through end-to-end, so a MySQL
`AUTO_INCREMENT` column becomes a Postgres `IDENTITY` column rather than a
plain integer.

### 9.3 The orchestrator

`pipeline.ts` → `runMigration(reader, writer, makeMapper, opts)`. Per
namespace:

1. **`inferring`** — `reader.inferSchema(ns, { sampleSize })`. Mongo samples
   documents (default 1000); SQL reads `information_schema`.
2. **`initialising`** — build the mapper, `mapper.translateSchema()`, then
   `writer.init(ns, destSchema)` which emits the `CREATE TABLE` / creates the
   collection.
3. **`streaming`** — pull from the reader, `mapper.mapRecord` each row, push
   into a batch, and flush at `batchSize` (default 1000). Each flush emits a
   progress tick and drains mapper warnings.
4. **`finalising`** — `writer.finalize(ns)` runs `ANALYZE`, creates secondary
   indexes, and resynchronises identity sequences.
5. **`done`** / **`failed`**.

`parallelism` (default 1) runs N namespaces through a bounded worker pool, but
each namespace still streams serially so ordering and checkpoints stay clean.
`dryRun: true` stops after step 1 and returns inferred schema plus warnings —
that is what the Migrate UI's preview shows.

### 9.4 Partial-failure detection

A genuinely subtle piece of logic. `writer.writeBatch` returns
`{ written, skipped, failed }` and does **not** throw on row-level rejection.
Without special handling, a run that lost 1,800 of 4,810 rows would report
"succeeded". So `runMigration` compares counters before and after each
namespace:

- `rowsFailed > 0` and `rowsWritten === 0` → the namespace counts as **failed**
- `rowsFailed > 0` and `rowsWritten > 0` → **partial**; the error list records
  the count and pulls a root-cause message from the optional
  `writer.getLastError(ns)`

### 9.5 Writer internals — why Postgres loads fast

`writers/postgres.writer.ts` is the most optimised path:

- **`COPY FROM STDIN`** in text format instead of multi-row `INSERT`. Roughly
  10–50× faster because it skips per-row parsing. Text rather than binary
  because it is far easier to debug and lands within ~20% of binary speed.
- **`SET session_replication_role = 'replica'`** on connect, which disables FK
  and trigger checks for the session. That removes the need to topologically
  sort tables before loading them.
- **Sequence resync in `finalize()`** — after a bulk load that supplied
  explicit ids, the identity sequence still points at 1, so the next ordinary
  `INSERT` would collide with the PK. `finalize` fast-forwards it.
- **Error log throttling** — full diagnostics are printed only for the *first*
  failing batch per namespace, so a large broken migration does not flood the
  logs. The most recent error per namespace is retained for the UI.

### 9.6 Live progress

`migration/worker.ts` runs the `migration-v2` BullMQ queue at `concurrency: 1`.
On every progress tick it both persists the per-namespace `progress` JSON
column and emits a Socket.IO event. Warnings are appended to a JSON array
capped at **500 entries** to keep the column small.

The Socket.IO protocol uses a room per run:

```
client → socket.emit('subscribe', runId)
server   socket.join(runId)
server → socket.emit('subscribed', { runId })
server → io.of('/migration-v2').to(runId).emit('progress' | 'warning' | 'done', …)
```

**Cancellation** is cooperative: the route sets `cancelRequested = true` on the
run row, and the `onProgress` hook — which fires between batches — checks the
flag and throws, unwinding through `runMigration`'s `finally` so readers and
writers still close.

### 9.7 Move — the legacy path

`services/migration.service.ts` is a completely separate, MongoDB-only
implementation that spawns `mongodump` and `mongorestore` as child processes
and streams their stdout to the browser as log lines. It supports
`--oplog`, `--gzip`, `--numParallelCollections`, and destination-drop options.
It survives as the "Move" page because native tools preserve index definitions
and options that the generic pipeline does not attempt to reproduce.

---

## 10. Sync — change data capture (CDC)

Where Migrate is a *bounded* copy, Sync is *unbounded*. Source:
`migration/cdc/` and `jobs/cdc-sync.job.ts`.

### 10.1 The `CdcSource` contract

```ts
interface CdcSource {
  captureStartCursor(): Promise<unknown>;               // position WITHOUT starting
  stream(opts: { startCursor?: unknown }): AsyncIterable<ChangeEvent>;
  close(): Promise<void>;
}
```

A `ChangeEvent` is normalised across engines:

```ts
{
  op: 'insert' | 'update' | 'delete',
  ns: { database, name },
  key:  Record<string, unknown>,   // PK / _id — always present
  doc?: DestRecord,                // post-change row; undefined on delete
  before?: DestRecord,             // only when the source captured it
  cursor: unknown,                 // opaque resume position
  committedAt?: Date,
}
```

### 10.2 The zero-gap snapshot handoff

The core correctness problem in CDC is the seam between "copy everything" and
"stream changes". PivotDB solves it by ordering operations deliberately:

```
1. cursor ← source.captureStartCursor()      ← position BEFORE anything
2. persist cursor to CdcSyncJob.cursor
3. run the full Migrate pipeline (snapshot)  ← writes happen during this
4. mark snapshotState = 'done'
5. source.stream({ startCursor: cursor })    ← replays step 3's window
```

Because the tail starts from *before* the snapshot began, every write that
occurred during the copy is replayed. Those replays are duplicates, which is
safe **only because `applyChange` is required to be idempotent** — writers
upsert on the primary key rather than blindly inserting.

### 10.3 Per-engine mechanics

**MongoDB** (`mongo.cdc.ts`) — wraps `Db.watch()` change streams.

- Cursor is the Mongo `resumeToken`; restart calls `watch({ resumeAfter })`.
- First-ever start uses `startAtOperationTime` from the current cluster time so
  no writes slip through between open and first read.
- `fullDocument: 'updateLookup'` means updates carry the whole post-change
  document, at the cost of one extra read per update event.
- `insert` and `replace` both map to `insert` (the writer upserts).
- `drop`, `dropDatabase`, `rename`, `invalidate` are skipped with a warning.
- **Requires a replica set or sharded cluster** — a standalone `mongod` has no
  oplog and the stream fails at open.

**PostgreSQL** (`postgres.cdc.ts`) — native logical replication.

- Uses the **`pgoutput`** plugin, which ships with PG 10+, deliberately instead
  of `wal2json` (an extra binary that managed providers like Supabase and Cloud
  SQL do not install).
- Provisions two server-side objects idempotently, both named after the job id:
  a **publication** (`mongovis_pub_<tag>`) declaring which tables emit WAL
  events, and a **replication slot** (`mongovis_slot_<tag>`) which retains WAL
  server-side until acknowledged. The slot is the durability primitive that
  makes a worker crash survivable.
- Cursor is `{ lsn }`. ACKs are sent every 10 seconds.
- **Server requirements:** `wal_level = logical`,
  `max_replication_slots ≥ N`, and a role with the `REPLICATION` attribute.

**MySQL** (`mysql.cdc.ts`) — reads the binary log via `@vlasky/zongji`.

- Consumes `WriteRows` / `UpdateRows` / `DeleteRows` events; `TableMap` events
  are cached to resolve numeric table ids; `Rotate` updates the cursor's file.
- Cursor is `{ file: 'mysql-bin.000003', position: 4242 }`.
- zongji's `TableMap` does not expose primary keys, so the adapter lazily
  queries `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` on first sight of each table
  and caches it.
- `server_id` is derived from the job id so concurrent syncs do not collide.
- **Server requirements:** `log_bin = ON`, `binlog_format = ROW`,
  `binlog_row_image = FULL`, non-zero `server_id`, and a user with
  `REPLICATION SLAVE` + `REPLICATION CLIENT` + `SELECT`.

### 10.4 Resilience — the reconnect strategy

CDC streams die for entirely ordinary reasons: idle TLS drops on free-tier
Neon and Supabase, NAT timeouts, brief network blips. The design treats
disconnection as normal rather than exceptional:

- BullMQ retries up to **1000 attempts** with exponential backoff from 5s,
  capped near 5 minutes — effectively infinite for the life of a sync.
- Because the replication slot / resume token lives **server-side**, a
  reconnect resumes from the last acknowledged position. No events are lost.
- `worker.on('failed')` keeps `status = 'tailing'` while retries remain and
  only flips to `failed` once attempts are exhausted — so a transient drop
  does not make the UI look broken.
- On successfully re-entering the stream loop, `lastError` is cleared, which
  stops a stale error banner from lingering on a healthy sync.

**Pausing** is checked in two places, and both are necessary. The in-loop check
between events cannot fire on a stream that is only seeing heartbeats, so
there is a second check at the top of every BullMQ attempt. Returning cleanly
(rather than throwing) means BullMQ marks the job complete and schedules no
retry; resuming re-enqueues fresh.

A single failing event increments an error counter, records `lastError`, and
**continues** — one poison row does not abort the stream.

---

## 11. Protect — backup and restore

### 11.1 Backup

`jobs/backup.job.ts`. The engine-specific part is only step 3; everything
around it is shared:

```
1. create BackupRun (status=running)
2. decrypt the connection URI
3. shell out to the native tool:
     mongodb  → mongodump
     postgres → pg_dump    (v17 client)
     mysql    → mysqldump  (mariadb-client)
4. tar the dump directory
5. gzip → optional AES-256-GCM encrypt → final archive
6. stat for size, mark run success
7. enforce retention: keep only the 3 most recent successful runs
```

Native tools are used rather than the generic pipeline because they capture
engine-specific fidelity — index definitions, collation, stored routines, user
grants — that a row-by-row copy does not reproduce.

### 11.2 Archive format

With `BACKUP_ENCRYPTION_KEY` set, the output is `<runId>.tar.gz.enc`:

```
┌────────────┬──────────────────────────────┬──────────────────┐
│ 12-byte IV │  AES-256-GCM(gzip(tar))      │ 16-byte auth tag │
└────────────┴──────────────────────────────┴──────────────────┘
```

The auth tag can only be computed *after* the last byte is encrypted, so it is
appended by a pass-through `Transform` whose `flush()` emits it — that way
`stream.pipeline()` writes it before closing the file. Without the key, output
is plain `<runId>.tar.gz`.

`decrypt-backup.mjs` at the repo root is a standalone recovery tool that
reverses this without needing the app running.

### 11.3 Restore

`jobs/restore.job.ts` reverses the pipeline — decrypt, gunzip, extract, then
invoke `mongorestore` / `pg_restore` / `mysql` against the **target**
connection, which need not be the connection the backup came from. That is what
makes "restore production into staging" a one-click operation. Progress is
written to `RestoreRun.log`.

---

## 12. Monitor, metrics and alerts

### 12.1 Monitor

Two services split by engine family: `monitor.service.ts` (MongoDB) and
`sql-monitor.service.ts` (PG + MySQL).

- **Snapshot caching** — each connection's snapshot is cached with a **3-second
  TTL**, so several UI panels polling at once produce one server round trip.
- **Ops/sec by differencing** — Mongo's `serverStatus` returns cumulative
  `opcounters`. The service keeps the previous reading per connection and
  divides the delta by elapsed time.
- **Replica set health** — `replSetGetStatus` is mapped through a numeric
  state table (`PRIMARY`, `SECONDARY`, `ARBITER`, …) with per-member lag.
- **Live current-ops** over Socket.IO. The server registers a *dynamic
  namespace* matching `/^\/monitor\/.+$/`; the connection id is parsed out of
  the namespace name and a `setInterval` pushes `currentops` every 3 seconds,
  cleared on disconnect.
- Also exposed: kill-op, slow queries (via the Mongo profiler), database and
  collection sizes, and for SQL — active queries, top tables, replication lag.

### 12.2 Prometheus metrics

`/metrics` is **unauthenticated** and merges two separate prom-client
registries whose prefixes are disjoint:

| Registry | Prefix | Examples |
|---|---|---|
| `metrics.service.ts` | `mongodb_` | `mongodb_connections_current`, `mongodb_ops_insert_per_sec`, `mongodb_replication_lag_seconds`, `mongodb_wt_cache_used_bytes` |
| `sql-metrics.service.ts` | `sqlmon_` | connection counts, cache hit ratio, replication lag |

Every gauge is labelled `connection_id` and `connection_name`, so one
Prometheus job covers every registered database. Collection happens **at scrape
time** — a scrape opens a client to each connection, which is why the scrape
interval is 15s rather than 1s.

Grafana is provisioned from `config/grafana/`: a read-only Prometheus
datasource plus one dashboard folder per engine, embedded into the Monitor page
as an iframe (hence Helmet's disabled CSP).

### 12.3 Alert state machine

`lib/alertEvaluator.ts`. Per rule:

```
      condition true                 stays true for durationMinutes
ok ──────────────────▶ pending ─────────────────────────────────▶ firing
▲                         │                                          │
└─────────────────────────┴──────────  condition false  ─────────────┘
                                       (auto-resolves open events)
```

- `firingStartedAt` is the duration clock — this is the debounce that stops a
  one-off spike from paging anyone.
- On transition to `firing`, an `AlertEvent` row is created and notifications
  go out through email (nodemailer) and/or webhook, subject to a **30-minute
  cooldown** tracked by `lastNotifiedAt`.
- Metrics that do not apply (e.g. `replicationLag` on a standalone server)
  return `null` and are skipped silently.
- Evaluation is **fire-and-forget from the snapshot route** — it must never
  throw or delay the snapshot response — with a **30-second cron sweep** as a
  safety net for connections nobody is actively viewing.

---

## 13. Background jobs and scheduling

### 13.1 Queues

| Queue | Worker | Concurrency | Retry policy |
|---|---|---|---|
| `migration-v2` | `migration/worker.ts` | 1 | default |
| `cdc-sync` | `jobs/cdc-sync.job.ts` | 5 | 1000 attempts, exponential from 5s |
| `backup` | `jobs/backup.job.ts` | default | default |
| `restore` | `jobs/restore.job.ts` | default | default |
| `export` | `jobs/export.job.ts` | default | default |
| `migration` (legacy) | `jobs/migration.job.ts` | 2 | default |

CDC jobs use a **deterministic BullMQ job id** (`cdc-<cdcSyncJobId>`), which
gives free deduplication — enqueuing an already-active sync is a no-op. Its
`lockDuration` is 60s, refreshed by progress heartbeats.

### 13.2 Two scheduling mechanisms, deliberately

`scheduler/index.ts` uses both, for different reasons:

- **BullMQ repeatable jobs** for backup schedules. They live in Redis, so they
  survive an API restart. The comment in the source is explicit that this was
  chosen over in-memory `node-cron` tasks because those can "ghost-fire" after
  a schedule change if `stop()` races with the event loop.
- **`node-cron`** for the 30-second in-process alert sweep, which is ephemeral
  by nature and does not need persistence.

All cron expressions are interpreted in `SCHEDULER_TZ` (default `UTC`), so the
times entered in the UI mean what the user expects regardless of server
timezone.

---

## 14. Frontend architecture

### 14.1 Structure

`App.tsx` defines a flat route table. `RequireAuth` is a trivial guard: if
`localStorage.token` is absent it redirects to `/login`. Everything
authenticated renders inside `<Layout>`, whose sidebar groups the pages:

| Group | Pages |
|---|---|
| **Data** | Connections, Explore |
| **Operate** | Monitor, Move, Migrate, Sync |
| **Governance** | Protect, Settings |

Page sizes tell you where the complexity is: `Monitor.tsx` (~1360 lines),
`Protect.tsx` (~1000), `Migrate.tsx` (~950), `Sync.tsx` (~525).

### 14.2 Data flow

- **`lib/api.ts`** (~500 lines) is a typed `fetch` wrapper. It injects the
  Bearer token, and centralises one important behaviour: **any `401` clears the
  token and hard-redirects to `/login`**, so an expired JWT cannot leave the UI
  in a half-authenticated state.
- **TanStack Query** owns server state — caching, refetching, invalidation.
- **zustand with `persist`** owns the little client state there is: the active
  connection id and the auth token, both mirrored into `localStorage`.
- **`lib/socket.ts`** caches one Socket.IO connection per monitored connection
  id, forcing `transports: ['websocket']` and passing the token in the
  handshake.

### 14.3 Dev-server proxying

`vite.config.ts` proxies `/api` and `/socket.io` (with `ws: true`) to
`localhost:3001`. It also installs a custom proxy error handler that swallows
`ECONNRESET` and `EPIPE` — those fire routinely whenever the browser tears down
a Socket.IO connection during HMR or a React StrictMode double-mount, and would
otherwise bury real errors in noise.

---

## 15. Known gaps and caveats found in the code

These are real observations from reading the source, not speculation.

1. **Cross-engine CDC does not run the mapper.** In
   `jobs/cdc-sync.job.ts`, `applyMappedChange()` passes `event.doc` straight
   through to the writer with an explicit `TODO (4B/4C/4D)`. Same-engine syncs
   (Mongo→Mongo, PG→PG) are correct; **cross-engine syncs are best-effort**
   because type translation that the Migrate path applies is skipped here.
   Note the *bootstrap snapshot* does use the full pipeline and mapper — it is
   only the tailing phase that passes raw.

2. **Nothing loads `.env`.** There is no `dotenv` dependency or
   `process.loadEnvFile()` call anywhere in `apps/api`. Environment variables
   must be exported by the shell. `dev.sh` does not source `.env` before
   `pnpm dev`, so a clean-shell run fails with
   `JWT_SECRET must be set`. (Prisma's CLI loads `.env` for migrations only.)

3. **Prometheus cannot scrape a host-run API.** `config/prometheus/prometheus.yml`
   targets `api:3001`, which only resolves inside the Docker network. When the
   API runs on the host via `pnpm dev`, the target is **down** and every Grafana
   panel is empty. The file's own comment documents the fix: bind-mount an
   override adding `host.docker.internal:3001`, and deliberately *not* list both
   targets in production, because they resolve to the same instance and every
   metric would be double-counted.

4. **`dev.sh` port check is misleading.** It waits on `nc -z localhost 5432`,
   which passes if *any* Postgres is listening — not necessarily PivotDB's.

5. **Two routers are installed.** `package.json` depends on both
   `@tanstack/react-router` and `react-router-dom`; `App.tsx` uses only
   `react-router-dom`. The TanStack router and its Vite plugin appear unused.

6. **Auth endpoints are nested under `/api/connections`** rather than a
   dedicated `/api/auth` prefix — a historical accident of where the handlers
   were written.

7. **`/metrics` is unauthenticated**, which is conventional for Prometheus but
   means gauge labels expose connection names to anyone who can reach port 3001.

8. **Retention is fixed at 3 successful runs** in `backup.job.ts`, even though
   `BackupJob.retentionDays` exists on the model and the README describes a
   day-based policy.

9. **The compose `version:` key is obsolete** and Docker Compose v2 warns about
   it on every invocation.

10. **Project naming is inconsistent** — the root package is
    `mongodb-visualizer`, the metadata database is `mongovis`, PG replication
    slots are prefixed `mongovis_`, and the product is called PivotDB. All refer
    to the same thing.

---

## 16. How to extend it

### Adding a fourth engine

The interfaces make the work mechanical:

1. Add the name to the `DbType` union in `lib/clients/types.ts`. Every
   exhaustive `switch` will now fail to compile — that list is your to-do list.
2. Implement `DbClient` in `lib/clients/<engine>.client.ts` and register it in
   `makeClient()`. Connections, Explore and discovery now work.
3. Implement `NamespaceReader` and `NamespaceWriter` under `migration/`.
4. Write mappers for each pair you want to support, translating through the
   canonical type set. Reuse `IdentityMapper` for the same-engine case.
5. Register the pair in `buildPlanForPair()` in `migration/service.ts`.
6. For Sync, implement `CdcSource` and call
   `registerCdcSourceAdapter('<engine>', factory)` — the registry exists
   specifically so adapters do not have to modify the worker.
7. For Protect, add a `dump<Engine>()` branch in `backup.job.ts` and install
   the native client tool in `apps/api/Dockerfile`.
8. For Monitor, add gauges to a metrics service and a Grafana dashboard JSON
   under `config/grafana/provisioning/dashboards/<engine>/`.

### Adding a new background job

Create the queue in `lib/queue.ts`, write the worker in `jobs/`, start it from
`index.ts`, and add `Job` + `Run` models to `schema.prisma` following the
existing definition/execution pairing.

---

## 17. Local development on this machine

### Prerequisites

Node 20+, pnpm 9+, Docker Desktop.

### Standard flow

```bash
cp .env.example .env
# generate secrets: openssl rand -hex 32
#   ENCRYPTION_KEY, JWT_SECRET, BACKUP_ENCRYPTION_KEY
# and add DATABASE_URL (absent from .env.example but required)

docker compose up -d postgres redis prometheus grafana
pnpm install
pnpm --filter api exec prisma migrate deploy
pnpm --filter api exec prisma generate

set -a && . ./.env && set +a    # the app does NOT load .env itself
pnpm dev
```

| Service | URL |
|---|---|
| Web UI | http://localhost:5173 |
| API | http://localhost:3001 |
| Grafana | http://localhost:3003 |
| Prometheus | http://localhost:9090 |

On first launch the UI routes to `/signup` to create the first superadmin.

### Deviations applied on this machine

- **Postgres is published on 5433, not 5432**, because port 5432 was already
  taken by an unrelated container. `docker-compose.override.yml` remaps it
  using the `!override` tag — necessary because Compose *appends* to port lists
  by default rather than replacing them. The container still listens on 5432
  internally, so nothing inside the compose network changes.
- **`apps/api/.env` is a symlink** to the root `.env`, so the Prisma CLI
  resolves `DATABASE_URL` when run from that directory.
- **`BACKUP_DIR`** points at `./backups` instead of the container path
  `/app/backups`.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | Prisma connection to the metadata DB |
| `ENCRYPTION_KEY` | ✅ | 64 hex chars. AES-256-GCM for connection URIs. **Losing it makes stored URIs unrecoverable.** |
| `JWT_SECRET` | ✅ | Token signing key |
| `POSTGRES_PASSWORD` | ✅ | Metadata DB password (used by compose) |
| `REDIS_URL` | – | Defaults to `redis://localhost:6379` |
| `BACKUP_ENCRYPTION_KEY` | recommended | Without it, backups are written as plain `.tar.gz` |
| `BACKUP_DIR` | – | Defaults to `/app/backups`; must be a persistent volume in production |
| `TEMP_DIR` | – | Defaults to `/tmp/mongovis` |
| `SCHEDULER_TZ` | – | Timezone for all cron expressions. Defaults to `UTC` |
| `SMTP_*` | – | Alert email channel |
| `GRAFANA_ADMIN_USER` / `_PASSWORD` | – | Grafana credentials |
| `VITE_API_URL` | – | Leave unset in dev; the Vite proxy handles it |
| `VITE_GRAFANA_URL` | – | Defaults to `http://localhost:3003` |

### Test databases

`dev/test-dbs/docker-compose.yml` brings up two seeded instances of each
engine (A and B), so all 9 migration directions can be exercised end to end
without touching real data.

For **Sync**, the coverage is uneven and the file says so explicitly:

- **Postgres** — both run `wal_level=logical`, usable as a CDC source.
- **MySQL** — both run `binlog-format=ROW` with `binlog-row-image=FULL`,
  usable as a CDC source.
- **MongoDB** — both are **standalone**, which is enough for migration but
  **not** for CDC. Change streams need an oplog, so testing Mongo as a sync
  source means pointing at Atlas or converting a container to a replica set
  by hand.
