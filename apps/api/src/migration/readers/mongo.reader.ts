import { MongoClient, type Db } from 'mongodb';
import type {
  NamespaceReader, NamespaceRef, InferredSchema, SourceRecord,
} from '../types.js';
import { sampleMongoCollection } from '../inference/mongo-sampler.js';

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);
const READ_BATCH = 1000;

/**
 * Mongo NamespaceReader.
 *
 * Owns a single MongoClient connection for the lifetime of one migration run.
 * Reuses Mongo's cursor for memory-bounded streaming; batchSize tuned to match
 * the pipeline's default writeBatch.
 */
export class MongoReader implements NamespaceReader {
  private client: MongoClient | null = null;

  constructor(private readonly uri: string) {}

  private async connect(): Promise<MongoClient> {
    if (!this.client) {
      this.client = new MongoClient(this.uri, {
        // Migration runs can be long — generous timeout, then rely on socket keepalive.
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
        // Read from secondaries when available to keep load off the primary.
        readPreference: 'secondaryPreferred',
      });
      await this.client.connect();
    }
    return this.client;
  }

  private async db(database: string): Promise<Db> {
    const client = await this.connect();
    return client.db(database);
  }

  async listNamespaces(database?: string): Promise<NamespaceRef[]> {
    const client = await this.connect();
    const out: NamespaceRef[] = [];

    const dbNames: string[] = database
      ? [database]
      : ((await client.db('admin').command({ listDatabases: 1 })).databases as Array<{ name: string }>)
        .map((d) => d.name)
        .filter((n) => !SYSTEM_DBS.has(n));

    for (const dbName of dbNames) {
      const db = client.db(dbName);
      const colls = await db.listCollections({}, { nameOnly: true }).toArray();
      for (const c of colls) {
        if (c.name.startsWith('system.')) continue;
        out.push({ database: dbName, name: c.name });
      }
    }
    return out;
  }

  async inferSchema(ns: NamespaceRef, opts: { sampleSize: number }): Promise<InferredSchema> {
    const db = await this.db(ns.database);
    return sampleMongoCollection(db.collection(ns.name), ns, opts);
  }

  async countExact(ns: NamespaceRef): Promise<number> {
    const db = await this.db(ns.database);
    return db.collection(ns.name).countDocuments({});
  }

  /**
   * Stream every document of the namespace.
   *
   * The cursor is closed in a finally block; if the consumer breaks out early
   * (`for await ... break`), the runtime calls AsyncIterator.return() which
   * triggers the finally path here.
   */
  async *read(ns: NamespaceRef): AsyncIterable<SourceRecord> {
    const db = await this.db(ns.database);
    const cursor = db.collection(ns.name).find(
      {},
      { batchSize: READ_BATCH, readPreference: 'secondaryPreferred' },
    );
    try {
      for await (const doc of cursor) {
        yield doc as SourceRecord;
      }
    } finally {
      await cursor.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }
}
