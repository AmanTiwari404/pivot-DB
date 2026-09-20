import { MongoClient } from 'mongodb';
import type { DbClient, DiscoveredColumn, DiscoveredNamespace, ProbeResult, RowPage } from './types.js';

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);
const DEFAULT_SAMPLE_SIZE = 1000;

/** Mongo implementation of DbClient. Each instance owns a short-lived MongoClient. */
export class MongoDbClient implements DbClient {
  readonly dbType = 'mongodb' as const;
  private client: MongoClient | null = null;

  constructor(private readonly uri: string) {}

  private async connect(): Promise<MongoClient> {
    if (!this.client) {
      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await this.client.connect();
    }
    return this.client;
  }

  async probe(): Promise<ProbeResult> {
    const start = Date.now();
    const client = await this.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    const latencyMs = Date.now() - start;
    let topology = 'standalone';
    if (hello.setName) topology = 'replicaSet';
    else if (hello.msg === 'isdbgrid') topology = 'sharded';
    const buildInfo = await admin.command({ buildInfo: 1 });
    return {
      version: buildInfo.version as string,
      latencyMs,
      topology,
      metadata: hello.setName ? { setName: hello.setName } : undefined,
    };
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.connect();
    const res = await client.db('admin').command({ listDatabases: 1 });
    return (res.databases as Array<{ name: string }>)
      .map((d) => d.name)
      .filter((n) => !SYSTEM_DBS.has(n));
  }

  async discoverSchema(database?: string, options: { sampleSize?: number } = {}): Promise<DiscoveredNamespace[]> {
    const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    const client = await this.connect();
    const dbs = database ? [database] : await this.listDatabases();
    const out: DiscoveredNamespace[] = [];

    for (const dbName of dbs) {
      const db = client.db(dbName);
      const colls = await db.listCollections({}, { nameOnly: true }).toArray();
      for (const c of colls) {
        if (c.name.startsWith('system.')) continue;
        const coll = db.collection(c.name);
        const approxCount = await coll.estimatedDocumentCount().catch(() => undefined);
        const docs = await coll
          .find({}, { limit: sampleSize, projection: {} })
          .toArray()
          .catch(() => []);
        out.push({
          database: dbName,
          name: c.name,
          approxCount,
          columns: inferColumns(docs, sampleSize),
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
    const coll = client.db(ns.database).collection(ns.name);
    const limit  = Math.max(1, Math.min(1000, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset));
    const [rows, total] = await Promise.all([
      coll.find({}).skip(offset).limit(limit).toArray(),
      coll.estimatedDocumentCount().catch(() => 0),
    ]);
    return { rows: rows as Array<Record<string, unknown>>, total, totalExact: false };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }
}

/**
 * Infer columns from a sample of Mongo documents.
 * Tracks per-field presence + observed BSON types so the UI can surface
 * mixed-type warnings before generating SQL DDL.
 */
function inferColumns(docs: Array<Record<string, unknown>>, sampleSize: number): DiscoveredColumn[] {
  const stats = new Map<string, { presence: number; types: Set<string> }>();

  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      const entry = stats.get(key) ?? { presence: 0, types: new Set<string>() };
      entry.presence++;
      entry.types.add(bsonType(doc[key]));
      stats.set(key, entry);
    }
  }

  return Array.from(stats.entries()).map(([name, info]) => {
    const types = Array.from(info.types);
    return {
      name,
      type: types.length === 1 ? types[0] : 'mixed',
      nullable: info.presence < (docs.length || sampleSize),
      primaryKey: name === '_id',
      presenceCount: info.presence,
      observedTypes: types.length > 1 ? types : undefined,
    };
  });
}

function bsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'object') {
    const o = v as { _bsontype?: string };
    if (o._bsontype === 'ObjectId') return 'objectid';
    if (o._bsontype === 'Decimal128') return 'decimal';
    if (o._bsontype === 'Long') return 'long';
    if (o._bsontype === 'Binary') return 'binary';
    return 'object';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return typeof v; // string | boolean
}
