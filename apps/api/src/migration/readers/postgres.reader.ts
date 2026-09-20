import { Client } from 'pg';
import QueryStream from 'pg-query-stream';
import type {
  CanonicalType, InferredColumn, InferredSchema, NamespaceReader,
  NamespaceRef, SchemaWarning, SourceRecord,
} from '../types.js';

const STREAM_BATCH = 1000;

/**
 * Postgres NamespaceReader.
 *
 * Schema reads come from `information_schema` — no sampling needed because
 * Postgres has a real declared schema. Row streaming uses `pg-query-stream`
 * which opens a server-side cursor; memory stays bounded regardless of table size.
 *
 * One pg.Client per reader instance. Migrations open + close exactly once per
 * run; we don't pool here because pooling adds complexity (which client owns
 * which cursor) without speeding up a single linear scan.
 */
export class PostgresReader implements NamespaceReader {
  private client: Client | null = null;

  constructor(
    private readonly uri: string,
    private readonly opts: { schemaName?: string } = {},
  ) {}

  private async connect(): Promise<Client> {
    if (!this.client) {
      const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(this.uri);
      this.client = new Client({
        connectionString: this.uri,
        connectionTimeoutMillis: 10_000,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      });
      // Without this, an idle TLS drop (Neon/Supabase free tiers, NAT
      // timeouts) crashes the entire API process. Logging + nulling the
      // cached client makes the next read transparently reconnect.
      this.client.on('error', (err) => {
        console.error('[postgres-reader] background error, invalidating cached connection:', err.message);
        this.client = null;
      });
      await this.client.connect();
    }
    return this.client;
  }

  async listNamespaces(database?: string): Promise<NamespaceRef[]> {
    const client = await this.connect();
    // `database` here refers to the PG schema (public, app_data, ...).
    // It's NOT the PG database — that's baked into the URI.
    const schemaName = database ?? this.opts.schemaName ?? 'public';
    const res = await client.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p')
       ORDER BY c.relname`,
      [schemaName],
    );
    return res.rows.map((r) => ({ database: schemaName, name: r.table_name }));
  }

  /**
   * Read declared schema from information_schema.
   * Maps PG native types to our CanonicalType set so the destination mapper
   * sees a uniform shape regardless of source engine.
   */
  async inferSchema(ns: NamespaceRef, _opts: { sampleSize: number }): Promise<InferredSchema> {
    const client = await this.connect();
    const warnings: SchemaWarning[] = [];

    const colsRes = await client.query<{
      column_name: string;
      udt_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      is_pk: boolean;
      fk_target: string | null;
      is_identity: 'YES' | 'NO' | null;
      column_default: string | null;
    }>(
      `SELECT
         c.column_name,
         c.udt_name,
         c.data_type,
         c.is_nullable,
         c.is_identity,
         c.column_default,
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
      [ns.database, ns.name],
    );

    const countRes = await client.query<{ approx: string }>(
      `SELECT c.reltuples::bigint::text AS approx
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=$2`,
      [ns.database, ns.name],
    );
    const raw = Number(countRes.rows[0]?.approx);
    const approxCount = Number.isFinite(raw) && raw >= 0 ? raw : undefined;

    const columns: InferredColumn[] = colsRes.rows.map((r) => {
      const { canonical, warn } = pgUdtToCanonical(r.udt_name);
      if (warn) {
        warnings.push({
          namespace: ns, column: r.column_name,
          severity: 'warn', code: 'pg_type_fallback',
          message: warn,
        });
      }
      const isIdentity = r.is_identity === 'YES';
      const isSerial = !!r.column_default && /^nextval\(/i.test(r.column_default);
      return {
        name: r.column_name,
        type: canonical,
        nullable: r.is_nullable === 'YES',
        primaryKey: r.is_pk || undefined,
        references: r.fk_target ?? undefined,
        autoIncrement: (isIdentity || isSerial) || undefined,
      };
    });

    // Composite PK warning — destination mapper needs to choose a strategy.
    const pkCols = columns.filter((c) => c.primaryKey);
    if (pkCols.length > 1) {
      warnings.push({
        namespace: ns,
        severity: 'info',
        code: 'composite_pk',
        message:
          `Table "${ns.database}.${ns.name}" has a composite primary key ` +
          `(${pkCols.map((c) => c.name).join(', ')}). The Mongo target will use a generated ` +
          `ObjectId for _id and store the composite key as a "pk" subdocument with a ` +
          `compound unique index.`,
      });
    }

    return { namespace: ns, approxCount, columns, warnings };
  }

  async countExact(ns: NamespaceRef): Promise<number> {
    const client = await this.connect();
    // SECURITY: ns.{database,name} are identifiers — never parameterise them in a values
    // slot. Quote them ourselves and rely on listNamespaces/inferSchema having validated
    // they came from information_schema (we never let an end-user pass them raw).
    const res = await client.query<{ c: string }>(
      `SELECT COUNT(*)::bigint::text AS c FROM "${ns.database}"."${ns.name}"`,
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /**
   * Stream all rows of a table via a server-side cursor.
   * pg-query-stream batches under the hood; we surface one row per yield.
   */
  async *read(ns: NamespaceRef): AsyncIterable<SourceRecord> {
    const client = await this.connect();
    const sql = `SELECT * FROM "${ns.database}"."${ns.name}"`;
    const stream = client.query(new QueryStream(sql, [], { batchSize: STREAM_BATCH }));
    try {
      for await (const row of stream) {
        yield row as SourceRecord;
      }
    } finally {
      // Closing the stream releases the cursor on the server.
      stream.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}

/**
 * Map a PG `pg_type.typname` (a.k.a. `information_schema.columns.udt_name`)
 * to our CanonicalType. Returns an optional warning when we had to widen.
 */
function pgUdtToCanonical(udt: string): { canonical: CanonicalType; warn?: string } {
  // Arrays — udt_name starts with underscore, e.g. _int4 = int4[]
  if (udt.startsWith('_')) return { canonical: 'array' };

  const map: Record<string, CanonicalType> = {
    int2: 'int', int4: 'int', int8: 'long',
    float4: 'float', float8: 'double',
    numeric: 'decimal', money: 'decimal',
    bool: 'boolean',
    text: 'string', varchar: 'string', char: 'string', bpchar: 'string', name: 'string',
    uuid: 'uuid',
    json: 'json', jsonb: 'jsonb',
    bytea: 'binary',
    date: 'date',
    timestamp: 'timestamp', timestamptz: 'timestamp',
    time: 'time', timetz: 'time',
  };
  if (udt in map) return { canonical: map[udt] };

  // Range types, hstore, custom enums, tsvector, …
  // We fall back to 'string' since the Mongo writer can always store a string,
  // and PG itself happily casts these to text for SELECT.
  return {
    canonical: 'string',
    warn:
      `PG type "${udt}" has no direct BSON equivalent; values will be stored as strings ` +
      `(use the mapping UI to override per-column).`,
  };
}
