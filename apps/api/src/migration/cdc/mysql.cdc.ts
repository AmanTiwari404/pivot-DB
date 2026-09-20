/**
 * MySQL CDC source — Phase 4D
 *
 * Reads the binary log (binlog) via `@vlasky/zongji`. MySQL's binlog is
 * the canonical source of truth for replication; in ROW format it emits
 * structured insert/update/delete events with column-level data.
 *
 * What the binlog stream looks like:
 *   - Rotate event       — binlog file roll (we update cursor.file)
 *   - TableMap event     — schema info for a numeric tableId (cached)
 *   - WriteRows event    — INSERT
 *   - UpdateRows event   — UPDATE (rows: [{ before, after }])
 *   - DeleteRows event   — DELETE
 *   - Xid / Query events — txn boundaries (ignored)
 *
 * Cursor is `{ file: 'mysql-bin.000003', position: 4242 }`. After each
 * applied row we advance `position` to the event's `nextPosition`. On a
 * restart we resume from the saved (file, position) — MySQL fills in any
 * gap between that point and the current binlog head.
 *
 * Server requirements (handled by the test container's `command:` block):
 *   - `log_bin = ON`
 *   - `binlog_format = ROW`
 *   - `binlog_row_image = FULL`
 *   - `server_id` non-zero
 *   - User has `REPLICATION SLAVE`, `REPLICATION CLIENT`, plus `SELECT`
 *     on the source schemas (zongji queries INFORMATION_SCHEMA for PKs)
 *
 * PK detection:
 *   zongji's TableMapEvent doesn't expose primary keys, so we lazily
 *   query INFORMATION_SCHEMA.KEY_COLUMN_USAGE on first sight of each
 *   (schema, table) and cache the result.
 */

import ZongJi, { type AnyBinlogEvent } from '@vlasky/zongji';
import mysql from 'mysql2/promise';
import type { CdcSource, ChangeEvent, NamespaceRef } from '../types.js';

interface MySqlCdcOpts {
  uri: string;
  database?: string;
  namespaces?: NamespaceRef[];
  /** Used to derive a stable server_id offset so concurrent CDC syncs
   *  don't collide on the same replica slot. */
  jobId?: string;
}

interface ParsedMysqlUri {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function parseMysqlUri(uri: string): ParsedMysqlUri {
  const u = new URL(uri);
  return {
    host:     u.hostname,
    port:     parseInt(u.port || '3306', 10),
    user:     decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

/**
 * Map a jobId to a stable, non-zero, 32-bit server_id. We hash the cuid
 * into a 31-bit space so two concurrent CDC syncs against the same MySQL
 * server don't pick the same id (MySQL refuses two replicas with matching
 * server_id).
 */
function serverIdFromJobId(jobId: string | undefined): number {
  const src = jobId ?? 'default';
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
  // Force into [2, 2^31 - 1]. Avoid 0 (invalid) and 1 (often the master).
  return Math.abs(h) % 2_147_483_645 + 2;
}

export class MySqlCdcSource implements CdcSource {
  private zongji: ZongJi | null = null;
  private readonly conn: ParsedMysqlUri;
  private readonly serverId: number;
  /** Cache PK columns per `schema.table`. Populated lazily. */
  private pkCache = new Map<string, string[]>();
  /** Track which binlog file the stream is currently in (updated on Rotate). */
  private currentFile: string | null = null;

  constructor(private readonly opts: MySqlCdcOpts) {
    this.conn = parseMysqlUri(opts.uri);
    if (this.opts.database) this.conn.database = this.opts.database;
    this.serverId = serverIdFromJobId(opts.jobId);
  }

  /**
   * Snapshot the current binlog head. We use `SHOW MASTER STATUS`
   * (MySQL <8.4) — `SHOW BINARY LOG STATUS` in 8.4+ returns the same
   * shape but the older syntax is broadly compatible.
   */
  async captureStartCursor(): Promise<unknown> {
    const c = await mysql.createConnection({
      host: this.conn.host, port: this.conn.port,
      user: this.conn.user, password: this.conn.password,
    });
    try {
      const [rows] = await c.query<mysql.RowDataPacket[]>('SHOW MASTER STATUS');
      const row = rows[0];
      if (!row) {
        throw new Error('SHOW MASTER STATUS returned no rows — is binary logging enabled?');
      }
      return { file: row.File as string, position: row.Position as number };
    } finally {
      await c.end().catch(() => {});
    }
  }

  /** Lazily look up primary-key columns for a (schema, table). */
  private async getPkCols(schema: string, table: string): Promise<string[]> {
    const cacheKey = `${schema}.${table}`;
    const cached = this.pkCache.get(cacheKey);
    if (cached) return cached;

    const c = await mysql.createConnection({
      host: this.conn.host, port: this.conn.port,
      user: this.conn.user, password: this.conn.password,
    });
    try {
      const [rows] = await c.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME
           FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
          ORDER BY ORDINAL_POSITION`,
        [schema, table],
      );
      const cols = rows.map((r) => r.COLUMN_NAME as string);
      this.pkCache.set(cacheKey, cols);
      return cols;
    } finally {
      await c.end().catch(() => {});
    }
  }

  async *stream(opts: { startCursor?: unknown }): AsyncIterable<ChangeEvent> {
    const startCursor = opts.startCursor as { file?: string; position?: number } | undefined;
    this.currentFile = startCursor?.file ?? null;

    const zongji = new ZongJi({
      host: this.conn.host, port: this.conn.port,
      user: this.conn.user, password: this.conn.password,
    });
    this.zongji = zongji;

    // Build schema filter. If namespaces are listed, restrict to those
    // tables (zongji's includeSchema lets us list per-schema tables).
    let includeSchema: Record<string, string[] | true> | undefined;
    if (this.opts.namespaces && this.opts.namespaces.length > 0) {
      includeSchema = {};
      for (const ns of this.opts.namespaces) {
        const list = (includeSchema[ns.database] as string[] | true | undefined);
        if (list === true) continue;
        if (Array.isArray(list)) list.push(ns.name);
        else includeSchema[ns.database] = [ns.name];
      }
    } else if (this.conn.database) {
      includeSchema = { [this.conn.database]: true };
    }

    // ── Bridge EventEmitter → AsyncIterable (queue + waker) ─────────────────
    type Pending = { event: ChangeEvent | null; error?: Error };
    const queue: Pending[] = [];
    let resolveWaker: ((v: void) => void) | null = null;
    const wake = () => { if (resolveWaker) { resolveWaker(); resolveWaker = null; } };

    zongji.on('error', (err: Error) => { queue.push({ event: null, error: err }); wake(); });

    zongji.on('binlog', (evt: AnyBinlogEvent) => {
      // The zongji 'binlog' callback is sync; we can't await PK lookup
      // here, so we push a Promise into the queue. The async iterator
      // unwraps it below.
      const name = evt.getEventName();

      if (name === 'rotate') {
        // New file — update currentFile so subsequent events reference it.
        const r = evt as unknown as { binlogName: string };
        this.currentFile = r.binlogName;
        return;
      }
      if (name !== 'writerows' && name !== 'updaterows' && name !== 'deleterows') return;

      const rowsEvt = evt as unknown as {
        tableId: number;
        tableMap: Record<number, { parentSchema: string; tableName: string }>;
        rows: Array<Record<string, unknown> | { before: Record<string, unknown>; after: Record<string, unknown> }>;
        nextPosition: number;
        timestamp: number;
      };
      const meta = rowsEvt.tableMap[rowsEvt.tableId];
      if (!meta) return;
      const ns: NamespaceRef = { database: meta.parentSchema, name: meta.tableName };

      // Queue a promise that resolves to the ChangeEvent (after PK lookup).
      // We push a placeholder and resolve it in the background.
      const op: 'insert' | 'update' | 'delete' =
        name === 'writerows' ? 'insert' : name === 'updaterows' ? 'update' : 'delete';

      void this.getPkCols(meta.parentSchema, meta.tableName)
        .then((pkCols) => {
          for (const raw of rowsEvt.rows) {
            const row = op === 'update'
              ? (raw as { after: Record<string, unknown> }).after
              : op === 'insert'
                ? (raw as Record<string, unknown>)
                : (raw as Record<string, unknown>);  // delete row

            const key: Record<string, unknown> = {};
            for (const c of pkCols) key[c] = row[c];

            const cursor = {
              file: this.currentFile ?? startCursor?.file ?? null,
              position: rowsEvt.nextPosition,
            };

            queue.push({
              event: {
                op,
                ns,
                key,
                doc: op === 'delete' ? undefined : row,
                cursor,
                committedAt: rowsEvt.timestamp ? new Date(rowsEvt.timestamp) : undefined,
              },
            });
            wake();
          }
        })
        .catch((err: Error) => {
          queue.push({ event: null, error: err });
          wake();
        });
    });

    // Start the stream. zongji.start() is sync (returns void); the
    // 'ready' event fires once it's connected.
    const startOpts: Record<string, unknown> = {
      serverId: this.serverId,
      includeEvents: ['rotate', 'tablemap', 'writerows', 'updaterows', 'deleterows'],
      excludeSchema: { mysql: true, information_schema: true, performance_schema: true, sys: true },
    };
    if (startCursor?.file && startCursor.position != null) {
      startOpts.filename = startCursor.file;
      startOpts.position = startCursor.position;
    } else {
      startOpts.startAtEnd = true;
    }
    if (includeSchema) startOpts.includeSchema = includeSchema;

    zongji.start(startOpts);

    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((res) => { resolveWaker = res; });
        }
        const item = queue.shift();
        if (!item) continue;
        if (item.error) throw item.error;
        if (item.event) yield item.event;
      }
    } finally {
      try { zongji.stop(); } catch { /* ignore */ }
      this.zongji = null;
    }
  }

  async close(): Promise<void> {
    if (this.zongji) {
      try { this.zongji.stop(); } catch { /* ignore */ }
      this.zongji = null;
    }
  }
}

/** Factory matching the CdcSourceFactory signature. */
export function createMysqlCdcSource(opts: {
  uri: string;
  database?: string;
  namespaces?: Array<{ database: string; name: string }>;
  jobId?: string;
}): CdcSource {
  return new MySqlCdcSource({
    uri: opts.uri,
    database: opts.database,
    namespaces: opts.namespaces?.map((n) => ({ database: n.database, name: n.name })),
    jobId: opts.jobId,
  });
}
