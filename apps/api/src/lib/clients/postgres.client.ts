import { Client } from 'pg';
import type { DbClient, DiscoveredColumn, DiscoveredNamespace, ProbeResult, RowPage } from './types.js';

/** Hard cap on rows per page — protects the server from a runaway request. */
const MAX_PAGE_SIZE = 1000;

/** Validate that an identifier is safe to embed in raw SQL (we always quote it). */
function validateIdent(s: string, kind: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(s)) {
    throw new Error(`Invalid ${kind} identifier: "${s}"`);
  }
  return s;
}

/**
 * Postgres implementation of DbClient.
 *
 * Uses a single `pg.Client` (not a pool) since each instance is short-lived —
 * one per UI probe / discovery request. Real migrations will use pools.
 *
 * SSL handling: if the URI ends with `?sslmode=require` (Supabase, Render, etc.)
 * `pg` parses it automatically. For self-signed certs we set
 * `rejectUnauthorized: false` so users don't have to upload a CA on first try.
 */
export class PostgresDbClient implements DbClient {
  readonly dbType = 'postgres' as const;
  private client: Client | null = null;

  constructor(private readonly uri: string) {}

  private async connect(): Promise<Client> {
    if (!this.client) {
      const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(this.uri);
      this.client = new Client({
        connectionString: this.uri,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10_000,
        // Lenient SSL by default — managed PGs (Supabase, Neon, RDS) need this.
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      });
      // ⚠️ pg.Client emits 'error' from background sources (socket drops,
      // keepalive failures). Without a listener, Node kills the process —
      // which is what happens on Neon/Supabase free tiers that idle-close
      // TLS sockets after ~5 min. Drop the cached client so the next call
      // reconnects transparently.
      this.client.on('error', (err) => {
        console.error('[postgres-client] background error, invalidating cached connection:', err.message);
        this.client = null;
      });
      await this.client.connect();
    }
    return this.client;
  }

  async probe(): Promise<ProbeResult> {
    const start = Date.now();
    const client = await this.connect();
    const res = await client.query<{ version: string; current_database: string; schemas: string[] }>(
      `SELECT
         current_setting('server_version') AS version,
         current_database() AS current_database,
         array(SELECT schema_name::text FROM information_schema.schemata
               WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')) AS schemas`,
    );
    const latencyMs = Date.now() - start;
    const row = res.rows[0];
    return {
      version: row.version,
      latencyMs,
      topology: 'standalone',
      metadata: {
        currentDatabase: row.current_database,
        schemas: row.schemas,
      },
    };
  }

  /**
   * For Postgres, `listDatabases()` returns SCHEMAS in the currently-connected
   * database — not other PG databases on the server.
   *
   * Why: a connection is bound to one PG database via the URI; to inspect a
   * different database you'd need a new URI. What the user actually wants to
   * navigate is the schema tree inside the current database (where the tables
   * live). This also matches the contract `discoverSchema(name)` expects.
   *
   * If we ever surface a cross-database picker we'll add a separate
   * `listServerDatabases()` method.
   */
  async listDatabases(): Promise<string[]> {
    const client = await this.connect();
    const res = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
       ORDER BY schema_name`,
    );
    return res.rows.map((r) => r.schema_name);
  }

  /**
   * For Postgres "database" arg = a schema (typically "public"). If omitted,
   * we walk every non-system schema in the *current* database.
   *
   * We don't connect to other Postgres databases — that would need fresh
   * Clients with rewritten URIs. The UI lets the user pick which DB to
   * connect to up front.
   */
  async discoverSchema(database?: string): Promise<DiscoveredNamespace[]> {
    const client = await this.connect();
    const schemas = database
      ? [database]
      : (await client.query<{ schema_name: string }>(
          `SELECT schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')`,
        )).rows.map((r) => r.schema_name);

    const out: DiscoveredNamespace[] = [];

    for (const schema of schemas) {
      const tables = await client.query<{ table_name: string; approx_count: number }>(
        `SELECT c.relname AS table_name,
                c.reltuples::bigint AS approx_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r','p')
         ORDER BY c.relname`,
        [schema],
      );

      for (const t of tables.rows) {
        const cols = await client.query<{
          column_name: string;
          data_type: string;
          is_nullable: 'YES' | 'NO';
          is_pk: boolean;
          fk_target: string | null;
        }>(
          `SELECT
             c.column_name,
             c.udt_name AS data_type,
             c.is_nullable,
             (
               EXISTS (
                 SELECT 1 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
                 WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema
                   AND tc.table_name=c.table_name AND kcu.column_name=c.column_name
               )
             ) AS is_pk,
             (
               SELECT ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
               JOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)
               WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=c.table_schema
                 AND tc.table_name=c.table_name AND kcu.column_name=c.column_name
               LIMIT 1
             ) AS fk_target
           FROM information_schema.columns c
           WHERE c.table_schema=$1 AND c.table_name=$2
           ORDER BY c.ordinal_position`,
          [schema, t.table_name],
        );

        // pg_class.reltuples returns -1 until ANALYZE runs on a fresh table.
        // Treat negative values as "unknown" instead of surfacing -1 to the UI.
        const rawCount = Number(t.approx_count);
        const approxCount = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : undefined;

        out.push({
          database: schema,
          name: t.table_name,
          approxCount,
          columns: cols.rows.map<DiscoveredColumn>((r) => ({
            name: r.column_name,
            type: normalizePgType(r.data_type),
            nullable: r.is_nullable === 'YES',
            primaryKey: r.is_pk || undefined,
            references: r.fk_target ?? undefined,
          })),
        });
      }
    }
    return out;
  }

  async fetchRows(
    ns: { database: string; name: string },
    opts: { limit: number; offset: number },
  ): Promise<RowPage> {
    const client = await this.connect();
    const schema = validateIdent(ns.database, 'schema');
    const table  = validateIdent(ns.name, 'table');
    const limit  = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset));

    // Stable order — by primary key if present, else by ctid (physical row id).
    // This keeps pagination consistent during concurrent inserts.
    const pkCols = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, table],
    );
    const orderBy = pkCols.rows.length > 0
      ? pkCols.rows.map((r) => `"${r.column_name}"`).join(', ')
      : 'ctid';

    // We deliberately do an exact COUNT(*) here because Explore is interactive
    // and users expect "1234 rows" to mean 1234, not "about 1200." For very
    // large tables this can be slow; we can add a fast-estimate switch later.
    const [rowsRes, countRes] = await Promise.all([
      client.query(
        `SELECT * FROM "${schema}"."${table}" ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      client.query<{ c: string }>(
        `SELECT COUNT(*)::bigint::text AS c FROM "${schema}"."${table}"`,
      ),
    ]);

    // Build column metadata from the field descriptors pg returns — cheaper
    // than another information_schema lookup and includes the actual types
    // pg sent over the wire (handles arrays etc. correctly).
    const columns: DiscoveredColumn[] = rowsRes.fields.map((f) => ({
      name: f.name,
      type: 'string', // canonical type isn't needed for Explore; the UI shows the value
      nullable: true,
    }));

    return {
      rows: rowsRes.rows as Array<Record<string, unknown>>,
      total: Number(countRes.rows[0]?.c ?? 0),
      totalExact: true,
      columns,
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}

/** Map Postgres internal type names (`pg_type.typname`) to our canonical tokens. */
function normalizePgType(t: string): string {
  // Strip leading underscore (array types: _int4 → int4[])
  if (t.startsWith('_')) return normalizePgType(t.slice(1)) + '[]';
  const map: Record<string, string> = {
    int2: 'int', int4: 'int', int8: 'long',
    float4: 'float', float8: 'double',
    numeric: 'decimal', money: 'decimal',
    bool: 'boolean',
    text: 'string', varchar: 'string', char: 'string', bpchar: 'string',
    uuid: 'uuid',
    json: 'json', jsonb: 'jsonb',
    bytea: 'binary',
    date: 'date',
    timestamp: 'timestamp', timestamptz: 'timestamp',
    time: 'time', timetz: 'time',
  };
  return map[t] ?? t;
}
