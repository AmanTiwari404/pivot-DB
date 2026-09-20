import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import type { DbClient, DiscoveredColumn, DiscoveredNamespace, ProbeResult, RowPage } from './types.js';

const MAX_PAGE_SIZE = 1000;

function validateIdent(s: string, kind: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(s)) {
    throw new Error(`Invalid ${kind} identifier: "${s}"`);
  }
  return s;
}

/**
 * MySQL implementation of DbClient.
 *
 * mysql2 parses standard `mysql://user:pass@host:port/db` URIs.
 * We force utf8mb4 to avoid 4-byte char (emoji) data loss on read.
 */
export class MySqlDbClient implements DbClient {
  readonly dbType = 'mysql' as const;
  private conn: Connection | null = null;

  constructor(private readonly uri: string) {}

  private async connect(): Promise<Connection> {
    if (!this.conn) {
      this.conn = await mysql.createConnection({
        uri: this.uri,
        connectTimeout: 5000,
        // Always read in utf8mb4 — utf8mb3 (legacy) loses emoji etc.
        charset: 'utf8mb4',
        // Surface SSL via the URI if needed (?ssl={"rejectUnauthorized":false}).
        // Otherwise mysql2 picks based on server's TLS support.
      });
    }
    return this.conn;
  }

  async probe(): Promise<ProbeResult> {
    const start = Date.now();
    const conn = await this.connect();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT VERSION() AS version, DATABASE() AS current_database`,
    );
    const latencyMs = Date.now() - start;
    const row = rows[0];
    return {
      version: String(row.version),
      latencyMs,
      topology: 'standalone',
      metadata: {
        currentDatabase: row.current_database,
      },
    };
  }

  async listDatabases(): Promise<string[]> {
    const conn = await this.connect();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys')
       ORDER BY schema_name`,
    );
    return rows.map((r) => String(r.schema_name ?? r.SCHEMA_NAME));
  }

  async discoverSchema(database?: string): Promise<DiscoveredNamespace[]> {
    const conn = await this.connect();
    const dbs = database ? [database] : await this.listDatabases();
    const out: DiscoveredNamespace[] = [];

    for (const dbName of dbs) {
      const [tables] = await conn.query<RowDataPacket[]>(
        `SELECT table_name, table_rows AS approx_count
         FROM information_schema.tables
         WHERE table_schema=? AND table_type='BASE TABLE'
         ORDER BY table_name`,
        [dbName],
      );

      for (const t of tables) {
        const tableName = String(t.table_name ?? t.TABLE_NAME);

        const [cols] = await conn.query<RowDataPacket[]>(
          `SELECT
             c.column_name,
             c.data_type,
             c.column_type,
             c.is_nullable,
             c.column_key,
             (
               SELECT CONCAT(kcu.referenced_table_schema, '.', kcu.referenced_table_name, '.', kcu.referenced_column_name)
               FROM information_schema.key_column_usage kcu
               WHERE kcu.table_schema=c.table_schema
                 AND kcu.table_name=c.table_name
                 AND kcu.column_name=c.column_name
                 AND kcu.referenced_table_name IS NOT NULL
               LIMIT 1
             ) AS fk_target
           FROM information_schema.columns c
           WHERE c.table_schema=? AND c.table_name=?
           ORDER BY c.ordinal_position`,
          [dbName, tableName],
        );

        out.push({
          database: dbName,
          name: tableName,
          approxCount: Number(t.approx_count ?? t.APPROX_COUNT) || undefined,
          columns: cols.map<DiscoveredColumn>((r) => {
            const dataType = String(r.data_type ?? r.DATA_TYPE);
            const columnType = String(r.column_type ?? r.COLUMN_TYPE);
            return {
              name: String(r.column_name ?? r.COLUMN_NAME),
              type: normalizeMyType(dataType, columnType),
              nullable: String(r.is_nullable ?? r.IS_NULLABLE) === 'YES',
              primaryKey: String(r.column_key ?? r.COLUMN_KEY) === 'PRI' || undefined,
              references: (r.fk_target ?? r.FK_TARGET) ?? undefined,
            };
          }),
        });
      }
    }
    return out;
  }

  async fetchRows(
    ns: { database: string; name: string },
    opts: { limit: number; offset: number },
  ): Promise<RowPage> {
    const conn = await this.connect();
    const db    = validateIdent(ns.database, 'database');
    const table = validateIdent(ns.name, 'table');
    const limit  = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset));

    // Use PK ordering if present, else natural insert order (MySQL's default).
    const [pkRows] = await conn.query<RowDataPacket[]>(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
       ORDER BY ordinal_position`,
      [db, table],
    );
    const orderBy = pkRows.length > 0
      ? pkRows.map((r) => '`' + String(r.column_name ?? r.COLUMN_NAME) + '`').join(', ')
      : '1';

    // Note: mysql2 doesn't allow placeholders for LIMIT/OFFSET in some configs,
    // so we inline the (already-sanitised) integers.
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT * FROM \`${db}\`.\`${table}\` ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    );

    const [countRows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM \`${db}\`.\`${table}\``,
    );

    // mysql2 doesn't expose typed field metadata in the same shape as pg; use
    // the keys of the first row as the column list. (Discovery provides
    // proper column metadata when the UI wants it.)
    const columns: DiscoveredColumn[] = rows.length > 0
      ? Object.keys(rows[0]).map((name) => ({ name, type: 'string', nullable: true }))
      : [];

    return {
      rows: rows as Array<Record<string, unknown>>,
      total: Number(countRows[0]?.c ?? 0),
      totalExact: true,
      columns,
    };
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.end().catch(() => {});
      this.conn = null;
    }
  }
}

/**
 * Map MySQL data types to canonical tokens.
 * `tinyint(1)` is treated as boolean — the MySQL community convention.
 */
function normalizeMyType(dataType: string, columnType: string): string {
  const dt = dataType.toLowerCase();
  if (dt === 'tinyint' && /^tinyint\(1\)/i.test(columnType)) return 'boolean';
  const map: Record<string, string> = {
    tinyint: 'int', smallint: 'int', mediumint: 'int', int: 'int', integer: 'int',
    bigint: 'long',
    float: 'float', double: 'double', real: 'double',
    decimal: 'decimal', numeric: 'decimal',
    bit: 'binary',
    char: 'string', varchar: 'string', text: 'string', tinytext: 'string', mediumtext: 'string', longtext: 'string',
    binary: 'binary', varbinary: 'binary', blob: 'binary', tinyblob: 'binary', mediumblob: 'binary', longblob: 'binary',
    date: 'date', datetime: 'timestamp', timestamp: 'timestamp', time: 'time', year: 'int',
    json: 'json',
    enum: 'string', set: 'string',
  };
  return map[dt] ?? dt;
}
