import { Registry, Gauge } from 'prom-client';
import { MongoClient } from 'mongodb';
import { decrypt } from '../crypto/encrypt.js';
import { prisma } from '../lib/prisma.js';

export class MetricsService {
  private registry: Registry;
  private connectionsCurrentGauge: Gauge;
  private connectionsAvailableGauge: Gauge;
  private opsInsertGauge: Gauge;
  private opsQueryGauge: Gauge;
  private opsUpdateGauge: Gauge;
  private opsDeleteGauge: Gauge;
  private opsGetmoreGauge: Gauge;
  private memResidentMbGauge: Gauge;
  private memVirtualMbGauge: Gauge;
  private networkBytesInGauge: Gauge;
  private networkBytesOutGauge: Gauge;
  private replicationLagSecondsGauge: Gauge;
  private wtCacheUsedBytesGauge: Gauge;
  private wtCacheMaxBytesGauge: Gauge;
  private prevOpcounters: Map<string, Record<string, number>> = new Map();

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ app: 'mongodb-visualizer' });
    const labels = ['connection_id', 'connection_name'];

    this.connectionsCurrentGauge    = new Gauge({ name: 'mongodb_connections_current',       help: 'Current number of connections',             labelNames: labels, registers: [this.registry] });
    this.connectionsAvailableGauge  = new Gauge({ name: 'mongodb_connections_available',      help: 'Available connections',                     labelNames: labels, registers: [this.registry] });
    this.opsInsertGauge             = new Gauge({ name: 'mongodb_ops_insert_per_sec',         help: 'Insert operations per second',              labelNames: labels, registers: [this.registry] });
    this.opsQueryGauge              = new Gauge({ name: 'mongodb_ops_query_per_sec',          help: 'Query operations per second',               labelNames: labels, registers: [this.registry] });
    this.opsUpdateGauge             = new Gauge({ name: 'mongodb_ops_update_per_sec',         help: 'Update operations per second',              labelNames: labels, registers: [this.registry] });
    this.opsDeleteGauge             = new Gauge({ name: 'mongodb_ops_delete_per_sec',         help: 'Delete operations per second',              labelNames: labels, registers: [this.registry] });
    this.opsGetmoreGauge            = new Gauge({ name: 'mongodb_ops_getmore_per_sec',        help: 'Getmore operations per second',             labelNames: labels, registers: [this.registry] });
    this.memResidentMbGauge         = new Gauge({ name: 'mongodb_memory_resident_mb',         help: 'Resident memory in MB',                     labelNames: labels, registers: [this.registry] });
    this.memVirtualMbGauge          = new Gauge({ name: 'mongodb_memory_virtual_mb',          help: 'Virtual memory in MB',                      labelNames: labels, registers: [this.registry] });
    this.networkBytesInGauge        = new Gauge({ name: 'mongodb_network_bytes_in_total',     help: 'Network bytes received',                    labelNames: labels, registers: [this.registry] });
    this.networkBytesOutGauge       = new Gauge({ name: 'mongodb_network_bytes_out_total',    help: 'Network bytes sent',                        labelNames: labels, registers: [this.registry] });
    this.replicationLagSecondsGauge = new Gauge({ name: 'mongodb_replication_lag_seconds',    help: 'Replication lag in seconds',                labelNames: [...labels, 'member'], registers: [this.registry] });
    this.wtCacheUsedBytesGauge      = new Gauge({ name: 'mongodb_wt_cache_used_bytes',        help: 'WiredTiger cache bytes currently in use',   labelNames: labels, registers: [this.registry] });
    this.wtCacheMaxBytesGauge       = new Gauge({ name: 'mongodb_wt_cache_max_bytes',         help: 'WiredTiger cache maximum configured bytes', labelNames: labels, registers: [this.registry] });
  }

  async collectAll(): Promise<void> {
    const connections = await prisma.connection.findMany();

    for (const conn of connections) {
      // Skip non-MongoDB connections — they have their own metrics service (sql-metrics.service.ts)
      if ((conn as { dbType?: string }).dbType && (conn as { dbType?: string }).dbType !== 'mongodb') continue;
      try {
        const uri    = decrypt(conn.encryptedUri);
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
        await client.connect();
        const admin  = client.db('admin');
        const lbs    = { connection_id: conn.id, connection_name: conn.name };

        const status = await admin.command({ serverStatus: 1 });

        this.connectionsCurrentGauge.set(lbs, status.connections.current);
        this.connectionsAvailableGauge.set(lbs, status.connections.available);

        const prev     = this.prevOpcounters.get(conn.id) ?? status.opcounters;
        const interval = 15;
        this.opsInsertGauge.set(lbs,  Math.max(0, (status.opcounters.insert  - (prev['insert']  ?? 0)) / interval));
        this.opsQueryGauge.set(lbs,   Math.max(0, (status.opcounters.query   - (prev['query']   ?? 0)) / interval));
        this.opsUpdateGauge.set(lbs,  Math.max(0, (status.opcounters.update  - (prev['update']  ?? 0)) / interval));
        this.opsDeleteGauge.set(lbs,  Math.max(0, (status.opcounters.delete  - (prev['delete']  ?? 0)) / interval));
        this.opsGetmoreGauge.set(lbs, Math.max(0, (status.opcounters.getmore - (prev['getmore'] ?? 0)) / interval));
        this.prevOpcounters.set(conn.id, { ...status.opcounters });

        this.memResidentMbGauge.set(lbs, status.mem.resident);
        this.memVirtualMbGauge.set(lbs,  status.mem.virtual);
        this.networkBytesInGauge.set(lbs,  status.network.bytesIn);
        this.networkBytesOutGauge.set(lbs, status.network.bytesOut);

        const wt = status.wiredTiger?.cache;
        if (wt) {
          this.wtCacheUsedBytesGauge.set(lbs, wt['bytes currently in the cache'] ?? 0);
          this.wtCacheMaxBytesGauge.set(lbs,  wt['maximum bytes configured'] ?? 0);
        }

        if (conn.topology === 'replicaSet') {
          try {
            const rsStatus = await admin.command({ replSetGetStatus: 1 });
            const primary  = rsStatus.members.find((m: Record<string, unknown>) => m['stateStr'] === 'PRIMARY');
            for (const member of rsStatus.members as Array<Record<string, unknown>>) {
              if (member['stateStr'] === 'SECONDARY' && (primary?.['optimeDate'] as Date) && (member['optimeDate'] as Date)) {
                const lagMs = (primary!['optimeDate'] as Date).getTime() - (member['optimeDate'] as Date).getTime();
                this.replicationLagSecondsGauge.set({ ...lbs, member: member['name'] as string }, lagMs / 1000);
              }
            }
          } catch { /* not authorised or standalone */ }
        }

        await client.close();
      } catch (err) {
        console.error(`[metrics] Failed to collect from ${conn.id}:`, (err as Error).message);
      }
    }
  }

  /**
   * Push gauge updates from a live MonitorSnapshot. Called by the
   * /:id/monitor/snapshot route so the UI's 5s poll also keeps Prometheus
   * fresh for actively-viewed connections (the 15s prom scrape covers idle ones).
   */
  updateFromSnapshot(connectionId: string, connectionName: string, snapshot: {
    currentConnections: number; availableConnections: number;
    opsPerSec: { insert: number; query: number; update: number; delete: number; getmore: number };
    memResident: number; memVirtual: number;
    networkBytesIn: number; networkBytesOut: number;
    wtCacheUsedMB: number; wtCacheMaxMB: number;
    replicaSet: { members: Array<{ name: string; lagSeconds: number | null }> } | null;
  }): void {
    const lbs = { connection_id: connectionId, connection_name: connectionName };
    this.connectionsCurrentGauge.set(lbs, snapshot.currentConnections);
    this.connectionsAvailableGauge.set(lbs, snapshot.availableConnections);
    this.opsInsertGauge.set(lbs, snapshot.opsPerSec.insert);
    this.opsQueryGauge.set(lbs, snapshot.opsPerSec.query);
    this.opsUpdateGauge.set(lbs, snapshot.opsPerSec.update);
    this.opsDeleteGauge.set(lbs, snapshot.opsPerSec.delete);
    this.opsGetmoreGauge.set(lbs, snapshot.opsPerSec.getmore);
    this.memResidentMbGauge.set(lbs, snapshot.memResident);
    this.memVirtualMbGauge.set(lbs, snapshot.memVirtual);
    this.networkBytesInGauge.set(lbs, snapshot.networkBytesIn);
    this.networkBytesOutGauge.set(lbs, snapshot.networkBytesOut);
    this.wtCacheUsedBytesGauge.set(lbs, snapshot.wtCacheUsedMB * 1024 * 1024);
    this.wtCacheMaxBytesGauge.set(lbs, snapshot.wtCacheMaxMB * 1024 * 1024);
    if (snapshot.replicaSet) {
      for (const m of snapshot.replicaSet.members) {
        if (m.lagSeconds !== null) {
          this.replicationLagSecondsGauge.set({ ...lbs, member: m.name }, m.lagSeconds);
        }
      }
    }
  }

  async getMetrics(): Promise<string> {
    await this.collectAll();
    return this.registry.metrics();
  }
}

export const metricsService = new MetricsService();
