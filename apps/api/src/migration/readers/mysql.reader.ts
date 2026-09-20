import mysql, { type Connection } from 'mysql2/promise';
import type {
  CanonicalType, InferredColumn, InferredSchema,
  NamespaceReader, NamespaceRef, SchemaWarning, SourceRecord,
} from '../types.js';

const STREAM_BATCH = 1000;

/**
 * MySQL NamespaceReader.
 *
 * Uses mysql2's streaming query interface for memory-bounded reads — the driver
 * returns rows through a Node.js Readable when `connection.query(sql).stream()`
 * is called, so we never materialise the full result set.
 *
 * Schema is read from `information_schema` — no sampling needed.
 */
export class MySqlReader implements NamespaceReader {
  private conn: Connection | null = null;

  constructor(
    private readonly uri: string,
    private readonly opts: { dbName?: string } = {},
  ) {}

  private async connect(): Promise<Connection> {
    if (!this.conn) {
      this.conn = await mysql.createConnection({
        uri: this.uri,
        connectTimeout: 10_000,
        charset: 'utf8mb4',
        // Enable multiple statements for SET commands.
        multipleStatements: false,
      });
    }
    return this.conn;
  }

  async listNamespaces(database?: string): Promise<NamespaceRef[]> {
    const conn = await this.connect();
    const dbName = database ?? this.opts.dbName;
    const where = dbName
      ? `WHERE t.table_schema = ? AND t.table_type = 'BASE TABLE'`
      : `WHERE t.table_schema NOT IN ('mysql','information_schema','performance_schema','sys') AND t.table_type = 'BASE TABLE'`;
    const params = dbName ? [dbName] : [];

    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT t.table_schema AS db, t.table_name AS name
       FROM information_schema.tables t ${where}
       ORDER BY t.table_schema, t.table_name`,
      params,
    );
    return rows.map((r) => ({ database: String(r.db), name: String(r.name) }));
  }

  async inferSchema(ns: NamespaceRef, _opts: { sampleSize: number }): Promise<InferredSchema> {
    const conn = await this.connect();
    const warnings: SchemaWarning[] = [];

    const [colRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT
         c.column_name,
         c.data_type,
         c.column_type,
         c.is_nullable,
         c.column_key,
         c.extra,
         (
           SELECT CONCAT(kcu.referenced_table_schema,'.',kcu.referenced_table_name,'.',kcu.referenced_column_name)
           FROM information_schema.key_column_usage kcu
           WHERE kcu.table_schema = c.table_schema
             AND kcu.table_name   = c.table_name
             AND kcu.column_name  = c.column_name
             AND kcu.referenced_table_name IS NOT NULL
           LIMIT 1
         ) AS fk_target
       FROM information_schema.columns c
       WHERE c.table_schema = ? AND c.table_name = ?
       ORDER BY c.ordinal_position`,
      [ns.database, ns.name],
    );

    const [cntRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT table_rows AS approx FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ?`,
      [ns.database, ns.name],
    );
    const approxCount = Number(cntRows[0]?.approx) || undefined;

    const pkCols: string[] = [];
    const columns: InferredColumn[] = colRows.map((r) => {
      const dt = String(r.data_type ?? r.DATA_TYPE);
      const ct = String(r.column_type ?? r.COLUMN_TYPE);
      const canonical = mysqlTypeToCanonical(dt, ct);

      if (canonical === 'unknown') {
        warnings.push({
          namespace: ns,
          column: String(r.column_name),
          severity: 'warn',
          code: 'mysql_type_fallback',
          message: `MySQL type "${ct}" has no direct equivalent; stored as TEXT.`,
        });
      }

      const isPk = String(r.column_key ?? r.COLUMN_KEY) === 'PRI';
      if (isPk) pkCols.push(String(r.column_name));
      const extra = String(r.extra ?? r.EXTRA ?? '').toLowerCase();
      const autoIncrement = extra.includes('auto_increment') || undefined;

      return {
        name: String(r.column_name ?? r.COLUMN_NAME),
        type: canonical,
        nullable: String(r.is_nullable ?? r.IS_NULLABLE) === 'YES',
        primaryKey: isPk || undefined,
        references: (r.fk_target ?? r.FK_TARGET) ? String(r.fk_target ?? r.FK_TARGET) : undefined,
        autoIncrement,
      };
    });

    if (pkCols.length > 1) {
      warnings.push({
        namespace: ns,
        severity: 'info',
        code: 'composite_pk',
        message:
          `Table "${ns.database}.${ns.name}" has a composite primary key ` +
          `(${pkCols.join(', ')}). The Mongo target will use a generated ObjectId for _id ` +
          `and store the composite key as a "pk" subdocument with a compound unique index.`,
      });
    }

    return { namespace: ns, approxCount, columns, warnings };
  }

  async countExact(ns: NamespaceRef): Promise<number> {
    const conn = await this.connect();
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM \`${ns.database}\`.\`${ns.name}\``,
    );
    return Number(rows[0]?.c ?? 0);
  }

  async *read(ns: NamespaceRef): AsyncIterable<SourceRecord> {
    const conn = await this.connect();
    const sql = `SELECT * FROM \`${ns.database}\`.\`${ns.name}\``;

    // mysql2/promise wraps the callback driver; only the underlying callback
    // connection exposes Query#stream(). Drop down to it for unbuffered reads.
    const raw = (conn as unknown as { connection: { query: (sql: string) => { stream: (opts: { highWaterMark: number }) => NodeJS.ReadableStream } } }).connection;
    const stream = raw.query(sql).stream({ highWaterMark: STREAM_BATCH });
    try {
      for await (const row of stream) {
        yield row as unknown as SourceRecord;
      }
    } finally {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.end().catch(() => {});
      this.conn = null;
    }
  }
}

function mysqlTypeToCanonical(dt: string, ct: string): CanonicalType {
  const d = dt.toLowerCase();
  if (d === 'tinyint' && /^tinyint\(1\)/i.test(ct)) return 'boolean';
  const map: Record<string, CanonicalType> = {
    tinyint: 'int', smallint: 'int', mediumint: 'int', int: 'int', integer: 'int',
    bigint: 'long',
    float: 'float',
    double: 'double', real: 'double',
    decimal: 'decimal', numeric: 'decimal',
    char: 'string', varchar: 'string',
    text: 'string', tinytext: 'string', mediumtext: 'string', longtext: 'string',
    binary: 'binary', varbinary: 'binary',
    blob: 'binary', tinyblob: 'binary', mediumblob: 'binary', longblob: 'binary',
    bit: 'binary',
    date: 'date',
    datetime: 'timestamp', timestamp: 'timestamp',
    time: 'time',
    year: 'int',
    json: 'json',
    enum: 'string', set: 'string',
  };
  return map[d] ?? 'unknown';
}
