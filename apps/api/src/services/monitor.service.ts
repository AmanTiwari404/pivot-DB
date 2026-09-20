import { Document } from 'mongodb';
import { decrypt } from '../crypto/encrypt.js';
import { prisma } from '../lib/prisma.js';
import { getMongoClient } from '../lib/mongo.js';

// ── shared helpers ───────────────────────────────────────────────────────────

export async function getClientForConnection(connectionId: string) {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const uri  = decrypt(conn.encryptedUri);
  return { client: await getMongoClient(connectionId, uri), conn };
}

const STATE_NAMES: Record<number, string> = {
  0: 'STARTUP',
  1: 'PRIMARY',
  2: 'SECONDARY',
  3: 'RECOVERING',
  5: 'STARTUP2',
  6: 'UNKNOWN',
  7: 'ARBITER',
  8: 'DOWN',
  9: 'ROLLBACK',
  10: 'REMOVED',
};

// ── per-connection snapshot cache (3s TTL) + opcounter history ───────────────

interface CachedSnapshot { at: number; snapshot: MonitorSnapshot }
const snapshotCache = new Map<string, CachedSnapshot>();

interface OpCountersPoint {
  at: number;          // ms epoch
  counters: Record<string, number>;
  network: { bytesIn: number; bytesOut: number; numRequests: number };
}
const lastOpcounters = new Map<string, OpCountersPoint>();

// ── types ────────────────────────────────────────────────────────────────────

export interface OpsPerSec {
  insert: number; query: number; update: number; delete: number;
  getmore: number; command: number;
}

export interface ReplicaMember {
  name: string;
  state: number;
  stateName: string;
  health: number;
  lagSeconds: number | null;
  self?: boolean;
}

export interface MonitorSnapshot {
  host: string;
  version: string;
  uptime: number;
  storageEngine: string;
  currentConnections: number;
  availableConnections: number;
  totalConnectionsCreated: number;
  opsPerSec: OpsPerSec;
  memResident: number;
  memVirtual: number;
  networkBytesIn: number;
  networkBytesOut: number;
  networkRequests: number;
  wtCacheUsedMB: number;
  wtCacheMaxMB: number;
  wtCacheHitRatio: number;
  docsRead: number;
  docsInserted: number;
  docsUpdated: number;
  docsDeleted: number;
  replicaSet: {
    name: string;
    myState: number;
    myStateName: string;
    members: ReplicaMember[];
  } | null;
  activeAlerts: number;
  timestamp: string;
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export async function getSnapshot(connectionId: string): Promise<MonitorSnapshot> {
  const cached = snapshotCache.get(connectionId);
  const now = Date.now();
  if (cached && now - cached.at < 3000) return cached.snapshot;

  const { client, conn } = await getClientForConnection(connectionId);
  const admin = client.db('admin');

  const status = await admin.command({ serverStatus: 1 }) as Document;

  // — ops/sec via delta on cumulative opcounters —
  const counters = (status.opcounters ?? {}) as Record<string, number>;
  const network  = (status.network ?? {}) as { bytesIn?: number; bytesOut?: number; numRequests?: number };
  const prev     = lastOpcounters.get(connectionId);
  const elapsedSec = prev ? Math.max(1, (now - prev.at) / 1000) : 1;

  const delta = (k: string): number => {
    if (!prev) return 0;
    return Math.max(0, ((counters[k] ?? 0) - (prev.counters[k] ?? 0)) / elapsedSec);
  };

  const opsPerSec: OpsPerSec = {
    insert:  delta('insert'),
    query:   delta('query'),
    update:  delta('update'),
    delete:  delta('delete'),
    getmore: delta('getmore'),
    command: delta('command'),
  };

  lastOpcounters.set(connectionId, {
    at: now,
    counters: { ...counters },
    network: {
      bytesIn:     network.bytesIn ?? 0,
      bytesOut:    network.bytesOut ?? 0,
      numRequests: network.numRequests ?? 0,
    },
  });

  // — WiredTiger cache —
  const wt = status.wiredTiger?.cache;
  const wtUsed = wt?.['bytes currently in the cache'] ?? 0;
  const wtMax  = wt?.['maximum bytes configured'] ?? 0;
  const wtPagesRead = wt?.['pages read into cache'] ?? 0;
  const wtPagesReq  = wt?.['pages requested from the cache'] ?? 0;
  const wtHitRatio  = wtPagesReq > 0
    ? Math.max(0, Math.min(100, (1 - wtPagesRead / wtPagesReq) * 100))
    : 100;

  // — Replica set —
  let replicaSet: MonitorSnapshot['replicaSet'] = null;
  try {
    const rs = await admin.command({ replSetGetStatus: 1 }) as Document;
    const members = (rs.members ?? []) as Array<Record<string, unknown>>;
    const primary = members.find((m) => m['stateStr'] === 'PRIMARY');
    const primaryOptime = primary?.['optimeDate'] instanceof Date ? primary['optimeDate'] as Date : null;

    replicaSet = {
      name: String(rs.set ?? ''),
      myState: Number(rs.myState ?? 0),
      myStateName: STATE_NAMES[Number(rs.myState ?? 0)] ?? 'UNKNOWN',
      members: members.map((m) => {
        const state = Number(m['state'] ?? 0);
        const stateStr = String(m['stateStr'] ?? STATE_NAMES[state] ?? 'UNKNOWN');
        const optime = m['optimeDate'] instanceof Date ? m['optimeDate'] as Date : null;
        let lagSeconds: number | null = null;
        if (stateStr === 'SECONDARY' && primaryOptime && optime) {
          lagSeconds = Math.max(0, (primaryOptime.getTime() - optime.getTime()) / 1000);
        } else if (stateStr === 'PRIMARY') {
          lagSeconds = 0;
        }
        return {
          name: String(m['name'] ?? ''),
          state,
          stateName: stateStr,
          health: Number(m['health'] ?? 0),
          lagSeconds,
          self: Boolean(m['self']),
        };
      }),
    };
  } catch { /* standalone or unauthorized */ }

  // — Active alerts (this profile + this connection, unresolved) —
  let activeAlerts = 0;
  try {
    activeAlerts = await prisma.alertEvent.count({
      where: {
        connectionId,
        status: 'firing',
      },
    });
  } catch { /* ignore */ }

  const docs = (status.metrics?.document ?? {}) as Record<string, number>;

  const snapshot: MonitorSnapshot = {
    host:                    String(status.host ?? conn.name),
    version:                 String(status.version ?? ''),
    uptime:                  Number(status.uptime ?? 0),
    storageEngine:           String(status.storageEngine?.name ?? 'unknown'),
    currentConnections:      Number(status.connections?.current ?? 0),
    availableConnections:    Number(status.connections?.available ?? 0),
    totalConnectionsCreated: Number(status.connections?.totalCreated ?? 0),
    opsPerSec,
    memResident:             Number(status.mem?.resident ?? 0),
    memVirtual:              Number(status.mem?.virtual ?? 0),
    networkBytesIn:          Number(network.bytesIn ?? 0),
    networkBytesOut:         Number(network.bytesOut ?? 0),
    networkRequests:         Number(network.numRequests ?? 0),
    wtCacheUsedMB:           wtUsed / (1024 * 1024),
    wtCacheMaxMB:            wtMax  / (1024 * 1024),
    wtCacheHitRatio:         wtHitRatio,
    docsRead:                Number(docs['returned'] ?? 0),
    docsInserted:            Number(docs['inserted'] ?? 0),
    docsUpdated:             Number(docs['updated'] ?? 0),
    docsDeleted:             Number(docs['deleted'] ?? 0),
    replicaSet,
    activeAlerts,
    timestamp:               new Date().toISOString(),
  };

  snapshotCache.set(connectionId, { at: now, snapshot });
  return snapshot;
}

// ── replica set (legacy raw) ─────────────────────────────────────────────────

export async function getReplicaSetStatus(connectionId: string) {
  const { client } = await getClientForConnection(connectionId);
  try {
    return await client.db('admin').command({ replSetGetStatus: 1 });
  } catch {
    return null;
  }
}

// ── current ops ──────────────────────────────────────────────────────────────

interface CurrentOp {
  opid: string | number;
  type: string;
  ns: string;
  op: string;
  durationMs: number;
  client: string;
  desc: string;
  waitingForLock: boolean;
  query?: Record<string, unknown>;
  planSummary?: string;
}

export async function getCurrentOps(connectionId: string): Promise<CurrentOp[]> {
  const { client } = await getClientForConnection(connectionId);
  const result = await client.db('admin').command({ currentOp: 1, active: true }) as Document;
  const inprog = (result.inprog ?? []) as Array<Record<string, unknown>>;

  return inprog
    .filter((op) => {
      const ns = String(op['ns'] ?? '');
      // filter out internal/system ops
      if (ns.startsWith('admin.') || ns.startsWith('local.') || ns.startsWith('config.')) return false;
      if (!ns && String(op['op'] ?? '') === 'none') return false;
      return true;
    })
    .map((op) => {
      const secs = Number(op['secs_running'] ?? 0);
      const microsecs = Number(op['microsecs_running'] ?? 0);
      const durationMs = microsecs > 0 ? microsecs / 1000 : secs * 1000;
      return {
        opid:           op['opid'] as string | number,
        type:           String(op['type'] ?? op['desc'] ?? 'op'),
        ns:             String(op['ns'] ?? ''),
        op:             String(op['op'] ?? ''),
        durationMs,
        client:         String(op['client'] ?? op['client_s'] ?? ''),
        desc:           String(op['desc'] ?? ''),
        waitingForLock: Boolean(op['waitingForLock']),
        query:          (op['command'] ?? op['query']) as Record<string, unknown> | undefined,
        planSummary:    op['planSummary'] as string | undefined,
      };
    });
}

// ── kill op ──────────────────────────────────────────────────────────────────

export async function killOp(connectionId: string, opid: number | string, actor: string) {
  const { client } = await getClientForConnection(connectionId);
  try {
    // MongoDB expects the opid as a number when possible
    const opIdValue: number | string = typeof opid === 'string' && /^\d+$/.test(opid)
      ? Number(opid)
      : opid;
    const result = await client.db('admin').command({ killOp: 1, op: opIdValue });
    await prisma.auditEvent.create({
      data: { actor, action: 'kill_op', target: `op:${opid}`, metadata: { connectionId } },
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('not authorized')) {
      const e = new Error('Not authorized to kill operations. The MongoDB user needs the killOp privilege.');
      (e as Error & { code?: number }).code = 403;
      throw e;
    }
    throw err;
  }
}

// ── slow queries ─────────────────────────────────────────────────────────────

interface SlowQuery {
  op: string;
  ns: string;
  durationMs: number;
  keysExamined: number;
  docsExamined: number;
  docsReturned: number;
  query: Record<string, unknown>;
  planSummary: string;
  ts: string;
}

export async function getSlowQueries(connectionId: string, thresholdMs = 100): Promise<SlowQuery[]> {
  const { client } = await getClientForConnection(connectionId);

  // system.profile lives in each user DB. We aggregate across all non-system DBs.
  const admin = client.db('admin');
  const dbList = await admin.command({ listDatabases: 1, nameOnly: true }) as Document;
  const userDbs = (dbList.databases as Array<{ name: string }>)
    .map((d) => d.name)
    .filter((n) => n !== 'admin' && n !== 'local' && n !== 'config');

  const all: SlowQuery[] = [];

  for (const dbName of userDbs) {
    try {
      const profile = await client.db(dbName).collection('system.profile')
        .find({ millis: { $gte: thresholdMs } })
        .sort({ ts: -1 })
        .limit(50)
        .toArray();
      for (const p of profile) {
        const ns = String(p['ns'] ?? `${dbName}.?`);
        all.push({
          op:           String(p['op'] ?? ''),
          ns,
          durationMs:   Number(p['millis'] ?? 0),
          keysExamined: Number(p['keysExamined'] ?? 0),
          docsExamined: Number(p['docsExamined'] ?? 0),
          docsReturned: Number(p['nreturned'] ?? p['nReturned'] ?? 0),
          query:        (p['command'] ?? p['query'] ?? {}) as Record<string, unknown>,
          planSummary:  String(p['planSummary'] ?? ''),
          ts:           (p['ts'] instanceof Date ? p['ts'].toISOString() : String(p['ts'] ?? '')),
        });
      }
    } catch { /* profile collection might not exist on this DB */ }
  }

  return all.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 100);
}

// Enable profiling on a database
export async function enableProfiling(connectionId: string, dbName: string, slowMs = 100) {
  const { client } = await getClientForConnection(connectionId);
  return client.db(dbName).command({ profile: 1, slowms: slowMs });
}

// ── database sizes ──────────────────────────────────────────────────────────

interface DbSize {
  db: string;
  sizeOnDisk: number;
  collections: number;
  objects: number;
  dataSize: number;
  indexSize: number;
  storageSize: number;
}

export async function getDatabaseSizes(connectionId: string): Promise<DbSize[]> {
  const { client } = await getClientForConnection(connectionId);
  const admin = client.db('admin');
  const dbList = await admin.command({ listDatabases: 1, nameOnly: false }) as Document;
  const out: DbSize[] = [];

  for (const db of (dbList.databases as Array<{ name: string; sizeOnDisk: number }>)) {
    try {
      const stats = await client.db(db.name).command({ dbStats: 1 }) as Document;
      out.push({
        db:          db.name,
        sizeOnDisk:  Number(db.sizeOnDisk ?? 0),
        collections: Number(stats.collections ?? 0),
        objects:     Number(stats.objects ?? 0),
        dataSize:    Number(stats.dataSize ?? 0),
        indexSize:   Number(stats.indexSize ?? 0),
        storageSize: Number(stats.storageSize ?? 0),
      });
    } catch { /* skip databases we cannot stat */ }
  }
  return out.sort((a, b) => b.dataSize - a.dataSize);
}

// ── collection sizes for one database ───────────────────────────────────────

interface CollSize {
  name: string;
  count: number;
  size: number;
  avgObjSize: number;
  storageSize: number;
  totalIndexSize: number;
  nindexes: number;
}

export async function getCollectionSizes(connectionId: string, dbName: string): Promise<CollSize[]> {
  const { client } = await getClientForConnection(connectionId);
  const db = client.db(dbName);
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();
  const out: CollSize[] = [];

  for (const c of collections) {
    if (c.type === 'view') continue;
    try {
      const stats = await db.command({ collStats: c.name }) as Document;
      out.push({
        name:           c.name,
        count:          Number(stats.count ?? 0),
        size:           Number(stats.size ?? 0),
        avgObjSize:     Number(stats.avgObjSize ?? 0),
        storageSize:    Number(stats.storageSize ?? 0),
        totalIndexSize: Number(stats.totalIndexSize ?? 0),
        nindexes:       Number(stats.nindexes ?? 0),
      });
    } catch { /* skip inaccessible collections */ }
  }

  return out.sort((a, b) => b.size - a.size);
}
