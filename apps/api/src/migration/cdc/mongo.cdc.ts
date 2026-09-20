/**
 * Mongo CDC source — Phase 4B
 *
 * Wraps `Db.watch()` change streams into the engine-agnostic CdcSource
 * interface. One stream covers all collections in the source database;
 * we filter via the aggregation pipeline if the SyncJob restricts to a
 * subset of collections.
 *
 * Resume semantics:
 *   - Each ChangeEvent.cursor is the Mongo resumeToken from that event.
 *   - Persisting it lets the next worker restart call db.watch({ resumeAfter }).
 *   - For the first-ever start we capture the current cluster time and use
 *     `startAtOperationTime` so we don't miss writes between open and read.
 *
 * Event mapping:
 *   - insert / replace  → op 'insert' (writer upserts → idempotent)
 *   - update            → op 'update' (uses fullDocument: updateLookup)
 *   - delete            → op 'delete'
 *   - drop / dropDb / invalidate / rename → skipped with a warning
 *
 * Caveats:
 *   - Requires the source to be a replica set or sharded cluster. Standalone
 *     mongod doesn't have an oplog and change streams will fail at open.
 *   - `updateLookup` does an extra read per update event. For very write-heavy
 *     workloads we could fall back to delta-only and let the writer merge,
 *     but Phase 4B keeps the simpler full-document path.
 */

import { MongoClient, type ChangeStream, type ChangeStreamDocument } from 'mongodb';
import type { CdcSource, ChangeEvent, NamespaceRef } from '../types.js';

interface MongoCdcOpts {
  uri: string;
  /** Source database name (Mongo CDC requires it — we don't span all DBs in 4B). */
  database?: string;
  /** Restrict to a subset of collections. If omitted, all collections are watched. */
  namespaces?: NamespaceRef[];
}

export class MongoCdcSource implements CdcSource {
  private client: MongoClient | null = null;
  private changeStream: ChangeStream | null = null;

  constructor(private readonly opts: MongoCdcOpts) {
    if (!opts.database) {
      throw new Error('MongoCdcSource requires opts.database (the source DB to watch)');
    }
  }

  private async connect(): Promise<MongoClient> {
    if (!this.client) {
      this.client = new MongoClient(this.opts.uri, {
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
      });
      await this.client.connect();
    }
    return this.client;
  }

  /**
   * Capture the current cluster operation time as a snapshot point.
   * Used when no resume token exists yet (first start of a sync job).
   *
   * We return `{ operationTime: <Timestamp as { t, i } object> }` so the
   * value survives a JSON round-trip into Postgres.
   */
  async captureStartCursor(): Promise<unknown> {
    const client = await this.connect();
    const adminDb = client.db('admin');
    const hello = await adminDb.command({ hello: 1 });
    // BSON Timestamp has shape { t: number, i: number }
    const opTime = hello.operationTime as { t: number; i: number } | undefined;
    if (!opTime) {
      throw new Error('Mongo server did not return operationTime — is this a replica set?');
    }
    return { operationTime: { t: opTime.t, i: opTime.i } };
  }

  /**
   * Open the change stream and yield ChangeEvents forever.
   * Iteration ends when the consumer calls close() (or breaks out).
   */
  async *stream(opts: { startCursor?: unknown }): AsyncIterable<ChangeEvent> {
    const client = await this.connect();
    const db = client.db(this.opts.database!);

    // Build aggregation pipeline. If specific collections were requested,
    // filter at the server side so we don't waste bandwidth.
    const pipeline: Record<string, unknown>[] = [];
    if (this.opts.namespaces && this.opts.namespaces.length > 0) {
      const colls = this.opts.namespaces.map((n) => n.name);
      pipeline.push({ $match: { 'ns.coll': { $in: colls } } });
    }

    // Decide where to resume from.
    const watchOpts: Record<string, unknown> = {
      fullDocument: 'updateLookup',
    };
    const startCursor = opts.startCursor as
      | { resumeAfter?: unknown; operationTime?: { t: number; i: number } }
      | undefined;
    if (startCursor?.resumeAfter) {
      watchOpts.resumeAfter = startCursor.resumeAfter;
    } else if (startCursor?.operationTime) {
      // mongodb driver accepts a { $timestamp: { t, i } } or BSON Timestamp.
      // Pass through the plain object — driver handles it.
      watchOpts.startAtOperationTime = startCursor.operationTime;
    }
    // else: tail from "now" — driver default.

    this.changeStream = db.watch(pipeline, watchOpts);

    try {
      for await (const raw of this.changeStream) {
        const mapped = this.mapEvent(raw);
        if (mapped) yield mapped;
      }
    } finally {
      // Stream iterator finished or threw — clean up.
      await this.changeStream?.close().catch(() => {});
      this.changeStream = null;
    }
  }

  /**
   * Translate Mongo's ChangeStreamDocument into our normalised ChangeEvent.
   * Returns null for events we deliberately ignore (drop/rename/invalidate).
   */
  private mapEvent(raw: ChangeStreamDocument): ChangeEvent | null {
    // resumeToken lives at raw._id for every change stream event.
    const cursor = { resumeAfter: (raw as { _id: unknown })._id };

    // Drop / dropDatabase / invalidate / rename → don't try to replay these
    // structurally on the destination. Worst case the user re-runs Migrate.
    if (raw.operationType === 'drop' ||
        raw.operationType === 'dropDatabase' ||
        raw.operationType === 'invalidate' ||
        raw.operationType === 'rename') {
      return null;
    }

    // All real CRUD events carry ns.db, ns.coll, documentKey.
    const ns = (raw as { ns?: { db?: string; coll?: string } }).ns;
    if (!ns?.db || !ns?.coll) return null;
    const namespace: NamespaceRef = { database: ns.db, name: ns.coll };

    const key = ((raw as { documentKey?: Record<string, unknown> }).documentKey) ?? {};
    const committedAt = (() => {
      const ct = (raw as { clusterTime?: { t?: number } }).clusterTime;
      return ct?.t ? new Date(ct.t * 1000) : undefined;
    })();

    if (raw.operationType === 'delete') {
      return { op: 'delete', ns: namespace, key, cursor, committedAt };
    }

    // insert / update / replace — all carry fullDocument (we requested updateLookup).
    const doc = (raw as { fullDocument?: Record<string, unknown> | null }).fullDocument;
    if (!doc) {
      // Document was deleted between the change event and the lookup —
      // we can't replicate this safely. Skip; the next event will catch up.
      return null;
    }

    const op =
      raw.operationType === 'insert'  ? 'insert' :
      raw.operationType === 'replace' ? 'insert' :  // dest writer upserts either way
      raw.operationType === 'update'  ? 'update' : null;
    if (!op) return null;

    return { op, ns: namespace, key, doc, cursor, committedAt };
  }

  async close(): Promise<void> {
    if (this.changeStream) {
      await this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }
}

/** Factory matching the CdcSourceFactory signature in cdc-sync.job.ts. */
export function createMongoCdcSource(opts: {
  uri: string;
  database?: string;
  namespaces?: Array<{ database: string; name: string }>;
}): CdcSource {
  return new MongoCdcSource({
    uri: opts.uri,
    database: opts.database,
    namespaces: opts.namespaces?.map((n) => ({ database: n.database, name: n.name })),
  });
}
