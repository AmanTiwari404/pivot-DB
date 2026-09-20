import { Client as PgClient } from 'pg';
import type { Connection as MyConnection, RowDataPacket } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { isValidDbType } from '../lib/uri-validators.js';
import type { DbType } from '../lib/clients/index.js';

/**
 * SQL monitoring service (Phase 2B).
 *
 * Returns a uniform `SqlMonitorSnapshot` regardless of whether the source
 * connection is Postgres or MySQL. The frontend renders one component.
 *
 * For numbers that are technically running totals since server start
 * (transactions, queries), the snapshot includes the engine's reported uptime
 * so the UI can present rates as "lifetime average" without making it look
 * like a real-time gauge. A future enhancement will add in-memory delta
 * tracking for true per-second rates.
 */

export interface SqlMonitorSnapshot {
  version: string;
  uptimeSeconds: number;
  currentDatabase: string;

  connections: {
    current: number;
    /** Max permitted by server config. May be null if not exposed. */
    max: number | null;
    active: number;
    idle: number;
  };

  throughput: {
    /** Average commits/sec since server start. */
    transactionsPerSec: number | null;
    /** Average queries/sec since server start (MySQL only). */
    queriesPerSec: number | null;
    /** Buffer-cache hit ratio in [0,1]. Higher is better. */
    cacheHitRatio: number | null;
  };

  /** Top-N tables ordered by size descending. */
  topTables: Array<{
    schema: string;
    name: string;
    sizeBytes: number;
    rowCount: number;
  }>;

  /** Currently-running queries (excludes idle / background workers). */
  activeQueries: Array<{
    pid: string;
    user: string;
    database: string;
    state: string;
    durationMs: number;
    /** Query text, capped at ~500 chars to avoid huge payloads. */
    query: string;
  }>;

  /** Replica status when the server is part of a replication topology. */
  replication: {
    isReplica: boolean;
    lagSeconds: number | null;
  } | null;
}

const TOP_TABLES_LIMIT = 10;
const ACTIVE_QUERY_LIMIT = 25;
const QUERY_TEXT_CAP = 500;

/** Entry point — resolves connection, dispatches to PG or MySQL impl. */
export async function getSqlMonitorSnapshot(connectionId: string): Promise<SqlMonitorSnapshot> {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const dbType: DbType = isValidDbType(conn.dbType) ? conn.dbType : 'mongodb';
  if (dbType === 'mongodb') {
    throw new Error('getSqlMonitorSnapshot is for SQL engines only (use the Mongo monitor endpoint)');
  }
  const uri = decrypt(conn.encryptedUri);
  if (dbType === 'postgres') return getPostgresSnapshot(uri);
  if (dbType === 'mysql')    return getMysqlSnapshot(uri);
  throw new Error(`Unsupported dbType for SQL monitor: ${String(dbType)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Postgres
// ─────────────────────────────────────────────────────────────────────────────

async function getPostgresSnapshot(uri: string): Promise<SqlMonitorSnapshot> {
  const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(uri);
  const client = new PgClient({
    connectionString: uri,
    connectionTimeoutMillis: 5000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  // Cloud free tiers (Neon, Supabase) idle-close TLS sockets. Without this
  // listener the resulting 'error' event is unhandled and kills the process.
  client.on('error', (err) => {
    console.error('[sql-monitor] background error on postgres client:', err.message);
  });
  await client.connect();
  try {
    // Run independent queries in parallel — they target different
    // pg_stat_* views and don't conflict.
    const [
      versionRes,
      uptimeRes,
      currentDbRes,
      maxConnRes,
      statActivityRes,
      dbStatsRes,
      topTablesRes,
      replicaRes,
    ] = await Promise.all([
      client.query<{ v: string }>(`SELECT current_setting('server_version') AS v`),
      client.query<{ uptime: string }>(
        `SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint::text AS uptime`,
      ),
      client.query<{ db: string }>(`SELECT current_database() AS db`),
      client.query<{ m: string }>(`SHOW max_connections`).catch(() => ({ rows: [{ m: null }] })),
      // pg_stat_activity rows for the current database, excluding our own session.
      client.query<{ total: string; active: string; idle: string }>(
        `SELECT
           COUNT(*)::bigint::text                                          AS total,
           SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END)::bigint::text AS active,
           SUM(CASE WHEN state = 'idle'   THEN 1 ELSE 0 END)::bigint::text AS idle
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      ),
      client.query<{ xact: string; blks_hit: string; blks_read: string }>(
        `SELECT
           (xact_commit + xact_rollback)::bigint::text AS xact,
           blks_hit::bigint::text                       AS blks_hit,
           blks_read::bigint::text                      AS blks_read
         FROM pg_stat_database
         WHERE datname = current_database()`,
      ),
      client.query<{ schemaname: string; relname: string; bytes: string; n_live_tup: string }>(
        `SELECT
           schemaname,
           relname,
           pg_total_relation_size(format('%I.%I', schemaname, relname))::bigint::text AS bytes,
           n_live_tup::bigint::text                                                    AS n_live_tup
         FROM pg_stat_user_tables
         ORDER BY pg_total_relation_size(format('%I.%I', schemaname, relname)) DESC
         LIMIT $1`,
        [TOP_TABLES_LIMIT],
      ),
      // pg_is_in_recovery() is true on standbys. lag = now - last replay timestamp.
      client.query<{ is_replica: boolean; lag: string | null }>(
        `SELECT
           pg_is_in_recovery() AS is_replica,
           CASE WHEN pg_is_in_recovery()
                THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint::text
                ELSE NULL END AS lag`,
      ),
    ]);

    // Active queries — query separately because column projection differs.
    const activeRes = await client.query<{
      pid: number; usename: string; datname: string;
      state: string; duration_ms: string; query: string;
    }>(
      `SELECT
         pid, usename, datname, state,
         EXTRACT(EPOCH FROM (now() - query_start))::numeric(20,3)::text AS duration_ms,
         query
       FROM pg_stat_activity
       WHERE state <> 'idle' AND pid <> pg_backend_pid() AND query <> ''
       ORDER BY query_start ASC
       LIMIT $1`,
      [ACTIVE_QUERY_LIMIT],
    );

    const uptime = Number(uptimeRes.rows[0]?.uptime ?? 0);
    const xact = Number(dbStatsRes.rows[0]?.xact ?? 0);
    const hit = Number(dbStatsRes.rows[0]?.blks_hit ?? 0);
    const read = Number(dbStatsRes.rows[0]?.blks_read ?? 0);
    const totalIo = hit + read;

    const conns = statActivityRes.rows[0] ?? { total: '0', active: '0', idle: '0' };

    return {
      version: versionRes.rows[0]?.v ?? 'unknown',
      uptimeSeconds: uptime,
      currentDatabase: currentDbRes.rows[0]?.db ?? '',
      connections: {
        // +1 for our own session that we excluded above — accurate UX.
        current: Number(conns.total) + 1,
        max: maxConnRes.rows[0]?.m != null ? Number(maxConnRes.rows[0].m) : null,
        active: Number(conns.active),
        idle: Number(conns.idle),
      },
      throughput: {
        transactionsPerSec: uptime > 0 ? Number((xact / uptime).toFixed(2)) : 0,
        queriesPerSec: null, // PG doesn't expose a per-query counter equivalent.
        cacheHitRatio: totalIo > 0 ? Number((hit / totalIo).toFixed(4)) : null,
      },
      topTables: topTablesRes.rows.map((r) => ({
        schema: r.schemaname,
        name: r.relname,
        sizeBytes: Number(r.bytes),
        rowCount: Number(r.n_live_tup),
      })),
      activeQueries: activeRes.rows.map((r) => ({
        pid: String(r.pid),
        user: r.usename ?? '',
        database: r.datname ?? '',
        state: r.state ?? '',
        durationMs: Math.round(Number(r.duration_ms) * 1000),
        query: (r.query ?? '').slice(0, QUERY_TEXT_CAP),
      })),
      replication: {
        isReplica: Boolean(replicaRes.rows[0]?.is_replica),
        lagSeconds: replicaRes.rows[0]?.lag != null ? Number(replicaRes.rows[0].lag) : null,
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MySQL
// ─────────────────────────────────────────────────────────────────────────────

async function getMysqlSnapshot(uri: string): Promise<SqlMonitorSnapshot> {
  const conn: MyConnection = await mysql.createConnection({
    uri, connectTimeout: 5000, charset: 'utf8mb4',
  });
  try {
    const [
      versionRows, varsRows, statusRows, currentDbRows, topTablesRows, activeRows, slaveRows,
    ] = await Promise.all([
      conn.query<RowDataPacket[]>(`SELECT VERSION() AS v`),
      // GLOBAL VARIABLES gives us max_connections.
      conn.query<RowDataPacket[]>(`SHOW GLOBAL VARIABLES WHERE Variable_name = 'max_connections'`),
      // GLOBAL STATUS gives us Uptime, Threads_*, Com_commit, Innodb_buffer_pool_read*.
      conn.query<RowDataPacket[]>(
        `SHOW GLOBAL STATUS WHERE Variable_name IN (
          'Uptime','Threads_connected','Threads_running','Com_commit','Com_rollback',
          'Questions','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads'
        )`,
      ),
      conn.query<RowDataPacket[]>(`SELECT DATABASE() AS db`),
      // Tables ordered by total size (data + index). We pull from
      // INFORMATION_SCHEMA which is approximate for InnoDB but close enough
      // for an Explore-style UI.
      // NOTE: `ROWS` is a MySQL 8 reserved word — alias must be backticked.
      // We also alias to `row_count` defensively in case future MySQL versions
      // reserve more words; the JS side maps either spelling.
      conn.query<RowDataPacket[]>(
        `SELECT table_schema, table_name,
                (IFNULL(data_length,0) + IFNULL(index_length,0)) AS size_bytes,
                IFNULL(table_rows, 0) AS row_count
         FROM information_schema.tables
         WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
         ORDER BY size_bytes DESC
         LIMIT ?`,
        [TOP_TABLES_LIMIT],
      ),
      conn.query<RowDataPacket[]>(
        `SELECT id, user, db, command, state, time, info
         FROM information_schema.processlist
         WHERE command <> 'Sleep' AND info IS NOT NULL
         ORDER BY time DESC
         LIMIT ?`,
        [ACTIVE_QUERY_LIMIT],
      ),
      // SHOW SLAVE STATUS works on replicas; returns empty result set on
      // primaries. Wrap in catch to handle the "you don't have permission" case.
      conn.query<RowDataPacket[]>(`SHOW SLAVE STATUS`).catch(() => [[]] as unknown as [RowDataPacket[]]),
    ]);

    const status = mapKv(statusRows[0]);
    const vars = mapKv(varsRows[0]);

    const uptime = Number(status.Uptime ?? 0);
    const threadsConnected = Number(status.Threads_connected ?? 0);
    const threadsRunning = Number(status.Threads_running ?? 0);
    const commits = Number(status.Com_commit ?? 0) + Number(status.Com_rollback ?? 0);
    const questions = Number(status.Questions ?? 0);
    const bpReadReq = Number(status.Innodb_buffer_pool_read_requests ?? 0);
    const bpReads = Number(status.Innodb_buffer_pool_reads ?? 0);
    const totalBpIo = bpReadReq + bpReads;

    const slaveRow = (slaveRows[0] as RowDataPacket[])[0];
    const isReplica = !!slaveRow;
    const lagSeconds = slaveRow
      ? (slaveRow.Seconds_Behind_Master ?? slaveRow.SECONDS_BEHIND_MASTER)
      : null;

    return {
      version: String(versionRows[0][0]?.v ?? 'unknown'),
      uptimeSeconds: uptime,
      currentDatabase: String(currentDbRows[0][0]?.db ?? ''),
      connections: {
        current: threadsConnected,
        max: vars.max_connections != null ? Number(vars.max_connections) : null,
        active: threadsRunning,
        idle: Math.max(0, threadsConnected - threadsRunning),
      },
      throughput: {
        transactionsPerSec: uptime > 0 ? Number((commits / uptime).toFixed(2)) : 0,
        queriesPerSec:      uptime > 0 ? Number((questions / uptime).toFixed(2)) : 0,
        cacheHitRatio: totalBpIo > 0 ? Number((bpReadReq / totalBpIo).toFixed(4)) : null,
      },
      topTables: (topTablesRows[0] as RowDataPacket[]).map((r) => ({
        schema: String(r.table_schema ?? r.TABLE_SCHEMA),
        name: String(r.table_name ?? r.TABLE_NAME),
        sizeBytes: Number(r.size_bytes ?? r.SIZE_BYTES),
        rowCount: Number(r.row_count ?? r.ROW_COUNT),
      })),
      activeQueries: (activeRows[0] as RowDataPacket[]).map((r) => ({
        pid: String(r.id ?? r.ID),
        user: String(r.user ?? r.USER ?? ''),
        database: String(r.db ?? r.DB ?? ''),
        state: String(r.state ?? r.STATE ?? r.command ?? r.COMMAND ?? ''),
        // information_schema.processlist.time is in SECONDS.
        durationMs: Math.round(Number(r.time ?? r.TIME ?? 0) * 1000),
        query: String(r.info ?? r.INFO ?? '').slice(0, QUERY_TEXT_CAP),
      })),
      replication: {
        isReplica,
        lagSeconds: lagSeconds != null ? Number(lagSeconds) : null,
      },
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Flatten a mysql2 result of `SHOW … STATUS/VARIABLES` into a {name: value} map. */
function mapKv(rows: RowDataPacket[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = String(r.Variable_name ?? r.VARIABLE_NAME);
    const v = String(r.Value ?? r.VALUE ?? '');
    out[k] = v;
  }
  return out;
}
