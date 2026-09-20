import { Registry, Gauge } from 'prom-client';
import { prisma } from '../lib/prisma.js';
import { getSqlMonitorSnapshot } from './sql-monitor.service.js';

/**
 * SQL metrics service — Phase 2C.
 *
 * Mirrors `metrics.service.ts` (Mongo) but for Postgres and MySQL connections.
 * Pull-driven: `getMetrics()` is called by the `/metrics` route on every
 * Prometheus scrape (default scrape interval = 15s). Each scrape iterates the
 * active SQL connections and updates gauges from a fresh snapshot.
 *
 * Naming scheme: every metric prefixed `sqlmon_*` so it never collides with
 * the `mongodb_*` gauges from the Mongo collector. Every gauge has at minimum
 * `connection_id`, `connection_name`, and `db_type` labels so dashboards can
 * filter / template on any of them.
 *
 * Failure model: per-connection errors are caught + logged. One unreachable
 * server doesn't break the scrape; affected gauges simply stop updating until
 * the next successful poll (Prometheus shows the stale-data warning naturally).
 */

export class SqlMetricsService {
  readonly registry: Registry;

  private readonly connectionsCurrent: Gauge;
  private readonly connectionsMax: Gauge;
  private readonly connectionsActive: Gauge;
  private readonly connectionsIdle: Gauge;

  private readonly transactionsPerSec: Gauge;
  private readonly queriesPerSec: Gauge;
  private readonly cacheHitRatio: Gauge;
  private readonly uptimeSeconds: Gauge;
  private readonly activeQueries: Gauge;

  private readonly tableSizeBytes: Gauge;
  private readonly tableRowCount: Gauge;

  private readonly replicationLag: Gauge;
  private readonly replicaFlag: Gauge;

  /** When was the last successful collection per connection (epoch ms). */
  private readonly lastCollectedAt = new Map<string, number>();

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ app: 'mongodb-visualizer' });

    const labels = ['connection_id', 'connection_name', 'db_type'];
    const r = [this.registry];

    this.connectionsCurrent  = new Gauge({ name: 'sqlmon_connections_current',  help: 'Currently established connections',           labelNames: labels, registers: r });
    this.connectionsMax      = new Gauge({ name: 'sqlmon_connections_max',      help: 'Max connections configured on the server',    labelNames: labels, registers: r });
    this.connectionsActive   = new Gauge({ name: 'sqlmon_connections_active',   help: 'Connections currently running a query',        labelNames: labels, registers: r });
    this.connectionsIdle     = new Gauge({ name: 'sqlmon_connections_idle',     help: 'Connections currently idle',                   labelNames: labels, registers: r });

    this.transactionsPerSec  = new Gauge({ name: 'sqlmon_transactions_per_sec', help: 'Average commits+rollbacks per second since server start', labelNames: labels, registers: r });
    this.queriesPerSec       = new Gauge({ name: 'sqlmon_queries_per_sec',      help: 'Average queries per second since server start (MySQL)',   labelNames: labels, registers: r });
    this.cacheHitRatio       = new Gauge({ name: 'sqlmon_cache_hit_ratio',      help: 'Buffer cache hit ratio in [0,1]',              labelNames: labels, registers: r });
    this.uptimeSeconds       = new Gauge({ name: 'sqlmon_uptime_seconds',       help: 'Server uptime in seconds',                     labelNames: labels, registers: r });
    this.activeQueries       = new Gauge({ name: 'sqlmon_active_queries',       help: 'Number of currently running queries',          labelNames: labels, registers: r });

    // Table-level metrics get extra labels for the schema and table name so
    // dashboards can show per-table panels.
    this.tableSizeBytes      = new Gauge({ name: 'sqlmon_table_size_bytes',     help: 'On-disk size in bytes (top N tables only)',    labelNames: [...labels, 'schema', 'table_name'], registers: r });
    this.tableRowCount       = new Gauge({ name: 'sqlmon_table_rows',           help: 'Approx row count (top N tables only)',         labelNames: [...labels, 'schema', 'table_name'], registers: r });

    this.replicationLag      = new Gauge({ name: 'sqlmon_replication_lag_seconds', help: 'Replication lag in seconds (replicas only)', labelNames: labels, registers: r });
    // 1 if this server is a replica, 0 if primary, absent if unknown.
    this.replicaFlag         = new Gauge({ name: 'sqlmon_is_replica',           help: '1 if server is a replica, 0 if primary',       labelNames: labels, registers: r });
  }

  /**
   * Collect metrics from every active SQL connection in the database.
   * Called by `getMetrics()` (which Prometheus invokes per scrape).
   *
   * Errors are caught per-connection and logged. We deliberately *don't* clear
   * stale gauge values on error — Prometheus will recognize the missing scrape
   * via timestamp diffs and the dashboard will show a gap.
   */
  async collectAll(): Promise<void> {
    const conns = await prisma.connection.findMany({
      where: { dbType: { in: ['postgres', 'mysql'] } },
    });

    // Fan out — independent connections can be polled in parallel.
    // Bounded concurrency would be nice for 100+ connections; we'll add it
    // when someone reports that. 10 parallel is fine for normal deployments.
    await Promise.all(conns.map((conn) => this.collectOne(conn.id, conn.name, conn.dbType)));
  }

  private async collectOne(connectionId: string, connectionName: string, dbType: string): Promise<void> {
    const labels = { connection_id: connectionId, connection_name: connectionName, db_type: dbType };

    try {
      const snap = await getSqlMonitorSnapshot(connectionId);

      this.connectionsCurrent.set(labels, snap.connections.current);
      if (snap.connections.max != null) this.connectionsMax.set(labels, snap.connections.max);
      this.connectionsActive.set(labels, snap.connections.active);
      this.connectionsIdle.set(labels, snap.connections.idle);

      if (snap.throughput.transactionsPerSec != null) {
        this.transactionsPerSec.set(labels, snap.throughput.transactionsPerSec);
      }
      if (snap.throughput.queriesPerSec != null) {
        this.queriesPerSec.set(labels, snap.throughput.queriesPerSec);
      }
      if (snap.throughput.cacheHitRatio != null) {
        this.cacheHitRatio.set(labels, snap.throughput.cacheHitRatio);
      }
      this.uptimeSeconds.set(labels, snap.uptimeSeconds);
      this.activeQueries.set(labels, snap.activeQueries.length);

      // Table gauges — set one sample per (schema, table_name) in the top N.
      // Prometheus auto-handles the cardinality; old labels stay around until
      // a process restart, but for 10 tables × N connections this is fine.
      for (const t of snap.topTables) {
        const tLabels = { ...labels, schema: t.schema, table_name: t.name };
        this.tableSizeBytes.set(tLabels, t.sizeBytes);
        this.tableRowCount.set(tLabels, t.rowCount);
      }

      if (snap.replication) {
        this.replicaFlag.set(labels, snap.replication.isReplica ? 1 : 0);
        if (snap.replication.isReplica && snap.replication.lagSeconds != null) {
          this.replicationLag.set(labels, snap.replication.lagSeconds);
        }
      }

      this.lastCollectedAt.set(connectionId, Date.now());
    } catch (err) {
      // Per-connection errors are operational, not bugs — log + continue.
      // Common causes: SSL handshake failures, IP allowlist drops, creds rotated.
      console.error(`[sql-metrics] ${connectionName} (${dbType}): ${(err as Error).message}`);
    }
  }

  /**
   * Render the registry as Prometheus text format.
   * Includes a lazy `collectAll()` so each /metrics scrape gets fresh data —
   * matches the behaviour of the Mongo metrics service.
   */
  async getMetrics(): Promise<string> {
    await this.collectAll();
    return this.registry.metrics();
  }
}

export const sqlMetricsService = new SqlMetricsService();
