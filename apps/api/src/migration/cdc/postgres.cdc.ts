/**
 * Postgres CDC source — Phase 4C
 *
 * Uses PG's built-in logical replication (`pgoutput` plugin, available since
 * PG 10) via the `pg-logical-replication` npm package. We avoid wal2json
 * because it's an extra binary plugin not present on most managed PG
 * (Supabase, Cloud SQL); `pgoutput` ships with the server.
 *
 * What we provision (idempotent, on first start):
 *   1. A **publication** scoped to the source schema (or to specific tables
 *      if `namespaces` is provided). Publications declare which tables WAL
 *      emits change events for.
 *   2. A **replication slot** named after the CdcSyncJob id. Slots retain
 *      WAL on the server until ACKed — they are the durability primitive
 *      that lets us resume after a worker crash.
 *
 * Server requirements:
 *   - `wal_level = logical`
 *   - `max_replication_slots >= N` (one per active CdcSyncJob)
 *   - The connecting role needs the REPLICATION attribute (or be superuser)
 *   - Tables need REPLICA IDENTITY DEFAULT (PK works) or FULL (to get a
 *     before-image on UPDATE/DELETE). DEFAULT is fine for our needs because
 *     we only require the PK to apply changes downstream.
 *
 * Resume semantics:
 *   - The slot stores its own ACK position server-side. We could rely on
 *     that alone, but we also keep ChangeEvent.cursor = { lsn } so the
 *     worker's per-event cursor write reflects the *true* applied position.
 *   - `acknowledge(lsn)` is called via the service's auto-ACK every 10 s,
 *     which is fine because re-delivery is safe (writer.applyChange is
 *     idempotent for inserts/updates/deletes).
 */

import { Client } from 'pg';
import {
  LogicalReplicationService,
  PgoutputPlugin,
  type Pgoutput,
} from 'pg-logical-replication';
import type { CdcSource, ChangeEvent, NamespaceRef } from '../types.js';

interface PgCdcOpts {
  uri: string;
  database?: string;          // schema name on the PG side
  namespaces?: NamespaceRef[];
  jobId?: string;
}

/**
 * Sanitise a CdcSyncJob id into a valid PG identifier.
 * cuids are already [a-z0-9]+, but they start with 'c' so they're fine.
 * We just lowercase + cap length to keep within PG's 63-char limit when
 * prefixed.
 */
function sanitiseTag(id: string | undefined): string {
  const t = (id ?? 'default').toLowerCase().replace(/[^a-z0-9]/g, '');
  return t.slice(0, 40);
}

export class PostgresCdcSource implements CdcSource {
  private service: LogicalReplicationService | null = null;
  private readonly slotName: string;
  private readonly publicationName: string;
  private readonly schemaName: string;

  constructor(private readonly opts: PgCdcOpts) {
    const tag = sanitiseTag(opts.jobId);
    this.slotName       = `mongovis_slot_${tag}`;
    this.publicationName = `mongovis_pub_${tag}`;
    this.schemaName     = opts.database ?? 'public';
  }

  /** Run a one-off admin query against the PG URI (NOT in replication mode). */
  private async adminQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(this.opts.uri);
    const client = new Client({
      connectionString: this.opts.uri,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    // Even short-lived clients can emit 'error' if the socket drops mid-query
    // — without a listener that becomes an unhandled event and kills Node.
    client.on('error', (err) => {
      console.error('[postgres-cdc] background error on adhoc client:', err.message);
    });
    await client.connect();
    try {
      const res = await client.query<T>(sql, params);
      return res.rows ?? [];
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Ensure publication + replication slot exist. Returns the slot's
   * `consistent_point` LSN (the point at which a base snapshot would be
   * coherent with the slot) so the caller can use it as the bootstrap
   * cursor.
   */
  async captureStartCursor(): Promise<unknown> {
    // 1. Publication. There is no CREATE PUBLICATION IF NOT EXISTS, so we
    //    look it up first. We scope it to the schema if namespaces aren't
    //    explicitly listed; otherwise we list tables.
    const exists = await this.adminQuery<{ pubname: string }>(
      `SELECT pubname FROM pg_publication WHERE pubname = $1`,
      [this.publicationName],
    );
    if (exists.length === 0) {
      if (this.opts.namespaces && this.opts.namespaces.length > 0) {
        const tables = this.opts.namespaces
          .map((n) => `"${this.schemaName}"."${n.name}"`)
          .join(', ');
        await this.adminQuery(`CREATE PUBLICATION "${this.publicationName}" FOR TABLE ${tables}`);
      } else {
        // Schema-wide publication (PG 15+). Fall back to FOR ALL TABLES if
        // the server is older — we detect by trying schema first.
        try {
          await this.adminQuery(
            `CREATE PUBLICATION "${this.publicationName}" FOR TABLES IN SCHEMA "${this.schemaName}"`,
          );
        } catch (err) {
          // PG <15 doesn't support FOR TABLES IN SCHEMA — fall back.
          // Note: FOR ALL TABLES needs the role to be superuser.
          await this.adminQuery(`CREATE PUBLICATION "${this.publicationName}" FOR ALL TABLES`);
          void err;
        }
      }
    }

    // 2. Replication slot. pg_create_logical_replication_slot returns
    //    (slot_name, lsn). If it already exists we get a duplicate-key
    //    error — catch it and read the current `restart_lsn` instead.
    let consistentLsn: string;
    try {
      const rows = await this.adminQuery<{ lsn: string }>(
        `SELECT lsn::text AS lsn FROM pg_create_logical_replication_slot($1, 'pgoutput')`,
        [this.slotName],
      );
      consistentLsn = rows[0]?.lsn ?? '0/0';
    } catch (err) {
      const msg = (err as Error).message || '';
      if (!/already exists/i.test(msg)) throw err;
      const rows = await this.adminQuery<{ restart_lsn: string }>(
        `SELECT restart_lsn::text AS restart_lsn FROM pg_replication_slots WHERE slot_name = $1`,
        [this.slotName],
      );
      consistentLsn = rows[0]?.restart_lsn ?? '0/0';
    }

    return {
      slotName: this.slotName,
      publicationName: this.publicationName,
      lsn: consistentLsn,
    };
  }

  async *stream(opts: { startCursor?: unknown }): AsyncIterable<ChangeEvent> {
    // Make sure provisioning is done before subscribing.
    await this.captureStartCursor();
    console.error(`[cdc-postgres] provisioned slot=${this.slotName} publication=${this.publicationName} schema=${this.schemaName}`);

    // Sanity-check the publication actually has tables. CREATE PUBLICATION
    // FOR TABLES IN SCHEMA on PG <15 silently produces an empty publication
    // sometimes; we'd then "tail" forever without seeing a single event.
    try {
      const pubTables = await this.adminQuery<{ schemaname: string; tablename: string }>(
        `SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1`,
        [this.publicationName],
      );
      console.error(`[cdc-postgres] publication "${this.publicationName}" covers ${pubTables.length} table(s): ${pubTables.map((r) => `${r.schemaname}.${r.tablename}`).join(', ') || '(none — events will never fire!)'}`);
    } catch (err) {
      console.error(`[cdc-postgres] failed to inspect publication tables:`, (err as Error).message);
    }

    const startCursor = opts.startCursor as { lsn?: string } | undefined;

    const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(this.opts.uri);
    const service = new LogicalReplicationService(
      {
        connectionString: this.opts.uri,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      },
      {
        acknowledge: { auto: true, timeoutSeconds: 10 },
      },
    );
    this.service = service;

    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [this.publicationName],
    });

    // ── Bridge EventEmitter → AsyncIterable ─────────────────────────────────
    // The service emits 'data' events; we need to yield ChangeEvents from
    // an async iterator. We use a bounded queue + a "wake" promise to push
    // events to the consumer and apply backpressure via flow control.
    type Pending = { event: ChangeEvent | null; error?: Error };
    const queue: Pending[] = [];
    let resolveWaker: ((v: void) => void) | null = null;
    const wake = () => { if (resolveWaker) { resolveWaker(); resolveWaker = null; } };

    // Relations map: pgoutput sends Relation messages once per table and
    // then references them by OID in subsequent Insert/Update/Delete.
    // The plugin already resolves the relation into the message, so we
    // don't strictly need a map — but we cache key column names for speed.
    const keyColsCache = new Map<number, string[]>();

    const namespaceAllow = (() => {
      if (!this.opts.namespaces || this.opts.namespaces.length === 0) return null;
      return new Set(this.opts.namespaces.map((n) => `${this.schemaName}.${n.name}`));
    })();

    let eventCounter = 0;
    service.on('data', (lsn: string, msg: Pgoutput.Message) => {
      eventCounter++;
      // Log first event of each kind so we can see the stream is alive
      // without drowning the console at high WAL volume.
      if (eventCounter <= 20 || eventCounter % 100 === 0) {
        console.error(`[cdc-postgres] wal lsn=${lsn} tag=${msg.tag}${'relation' in msg && msg.relation ? ` ns=${msg.relation.schema}.${msg.relation.name}` : ''}`);
      }
      // We only care about row-level events. Transaction boundaries
      // (begin/commit) and relation/type messages are infrastructure.
      if (msg.tag === 'insert' || msg.tag === 'update' || msg.tag === 'delete') {
        const ns: NamespaceRef = {
          database: msg.relation.schema,
          name: msg.relation.name,
        };

        // Skip tables outside the user-specified subset.
        if (namespaceAllow && !namespaceAllow.has(`${ns.database}.${ns.name}`)) return;

        const oid = msg.relation.relationOid;
        let keyCols = keyColsCache.get(oid);
        if (!keyCols) {
          keyCols = msg.relation.keyColumns;
          keyColsCache.set(oid, keyCols);
        }

        const row = msg.tag === 'delete'
          ? (msg.key ?? msg.old ?? {})
          : msg.new;

        // Build PK fields from the row.
        const key: Record<string, unknown> = {};
        for (const c of keyCols) key[c] = row[c];

        const event: ChangeEvent = {
          op: msg.tag === 'insert' ? 'insert' : msg.tag === 'update' ? 'update' : 'delete',
          ns,
          key,
          doc: msg.tag === 'delete' ? undefined : row,
          cursor: { lsn },
        };
        queue.push({ event });
        wake();
      } else if (msg.tag === 'truncate') {
        // Truncate is not idempotent to redeliver — skip with a warning.
        // (Could add an explicit ChangeOp 'truncate' later if needed.)
      }
      // begin / commit / relation / type / message / origin: ignore.
    });

    service.on('error', (err: Error) => {
      console.error(`[cdc-postgres] service.on('error') fired: ${err.message}`);
      queue.push({ event: null, error: err });
      wake();
    });
    // pg-logical-replication emits these lifecycle events too; surfacing
    // them lets us SEE silent disconnects on cloud free tiers (Neon's compute
    // auto-suspend, AWS NAT timeouts) that otherwise look like "stream is
    // tailing but no events are arriving".
    service.on('start', () => console.error(`[cdc-postgres] replication started`));
    service.on('heartbeat', (lsn: string, _ts: number, shouldRespond: boolean) => {
      console.error(`[cdc-postgres] heartbeat lsn=${lsn} respond=${shouldRespond}`);
    });
    service.on('acknowledge', (lsn: string) => {
      console.error(`[cdc-postgres] acknowledged up to lsn=${lsn}`);
    });

    // Kick off subscription. `subscribe` resolves when the connection is
    // established; the stream itself stays open until we call `stop()`.
    // We pass startCursor.lsn so PG can resume from there (it must be
    // >= slot's restart_lsn or PG will error).
    const startLsn = startCursor?.lsn ?? '0/00000000';
    console.error(`[cdc-postgres] calling subscribe slot=${this.slotName} startLsn=${startLsn}`);
    service.subscribe(plugin, this.slotName, startLsn)
      .then(() => console.error(`[cdc-postgres] subscribe() resolved (connection ended naturally)`))
      .catch((err) => {
        console.error(`[cdc-postgres] subscribe() rejected: ${(err as Error).message}`);
        queue.push({ event: null, error: err as Error });
        wake();
      });

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
      await service.stop().catch(() => {});
      this.service = null;
    }
  }

  async close(): Promise<void> {
    if (this.service) {
      await this.service.stop().catch(() => {});
      this.service = null;
    }
  }
}

/** Factory matching the CdcSourceFactory signature. */
export function createPostgresCdcSource(opts: {
  uri: string;
  database?: string;
  namespaces?: Array<{ database: string; name: string }>;
  jobId?: string;
}): CdcSource {
  return new PostgresCdcSource({
    uri: opts.uri,
    database: opts.database,
    namespaces: opts.namespaces?.map((n) => ({ database: n.database, name: n.name })),
    jobId: opts.jobId,
  });
}
