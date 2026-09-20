/**
 * CDC Sync worker — Phase 4
 *
 * Lifecycle of one CdcSyncJob:
 *
 *   1. Worker picks up a BullMQ job from the "cdc-sync" queue.
 *   2. If bootstrap === "snapshot" AND cursor is null:
 *        a. Record pre-snapshot cursor from the CdcSource.
 *        b. Run a full Migrate-style copy (reuses pipeline.ts).
 *        c. Save the pre-snapshot cursor so the tail starts from BEFORE
 *           the snapshot began — guarantees no gap.
 *   3. Open the CdcSource stream from the saved cursor.
 *   4. For each ChangeEvent:
 *        a. Map the record via the engine mapper.
 *        b. Call writer.applyChange(event).
 *        c. Persist cursor + counts back to CdcSyncJob.cursor.
 *        d. Honour pauseRequested — drain in-flight and stop.
 *   5. Worker exits cleanly; BullMQ "delayed" re-enqueue keeps the job
 *      alive (see startCdcWorker for the auto-retry strategy).
 *
 * Phase 4A ships the shell + lifecycle. Adapters (Mongo 4B, PG 4C, MySQL 4D)
 * are plugged in as they land. Until an adapter exists for a given engine
 * the worker throws ENGINE_NOT_SUPPORTED so the job surfaces as "failed"
 * immediately rather than silently doing nothing.
 */

import { Worker, Job, Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import type { CdcSource, ChangeEvent, NamespaceWriter } from '../migration/types.js';

// ─── adapter registry (filled in by 4B/4C/4D) ───────────────────────────────
// Each factory receives the decrypted URI + optional database scope, and
// returns a CdcSource that yields ChangeEvents for that engine.
// We use a Map<string, CdcSourceFactory> so 4B/4C/4D can register themselves
// without modifying this file.

type CdcSourceFactory = (opts: {
  uri: string;
  database?: string;
  namespaces?: Array<{ database: string; name: string }>;
  /** Deterministic identifier for resources the adapter must provision
   *  (PG replication slot name, MySQL server_id, etc.). Derived from
   *  CdcSyncJob.id so a re-run of the same job reuses the same slot. */
  jobId?: string;
}) => CdcSource;

const CDC_SOURCE_REGISTRY = new Map<string, CdcSourceFactory>();

export function registerCdcSourceAdapter(engine: string, factory: CdcSourceFactory): void {
  CDC_SOURCE_REGISTRY.set(engine, factory);
}

// ─── writer factory ─────────────────────────────────────────────────────────
// Re-uses existing Phase 1 writers. We only need applyChange, so we open the
// writer without calling init/writeBatch/finalize.

import { MongoWriter }    from '../migration/writers/mongo.writer.js';
import { PostgresWriter } from '../migration/writers/postgres.writer.js';
import { MySqlWriter }    from '../migration/writers/mysql.writer.js';
import { createMongoCdcSource } from '../migration/cdc/mongo.cdc.js';
import { createPostgresCdcSource } from '../migration/cdc/postgres.cdc.js';
import { createMysqlCdcSource } from '../migration/cdc/mysql.cdc.js';
import { buildPlanForPair } from '../migration/service.js';
import { runMigration } from '../migration/pipeline.js';

// ─── adapter registration (Phase 4B+) ────────────────────────────────────────
// 4B: Mongo. 4C: Postgres logical replication. 4D: MySQL binlog.
registerCdcSourceAdapter('mongodb',  createMongoCdcSource);
registerCdcSourceAdapter('postgres', createPostgresCdcSource);
registerCdcSourceAdapter('mysql',    createMysqlCdcSource);

function makeWriter(
  engine: string,
  uri: string,
  opts: { dbName?: string; schemaName?: string; databaseOverride?: string },
): NamespaceWriter {
  switch (engine) {
    case 'mongodb':  return new MongoWriter(uri, { databaseOverride: opts.databaseOverride });
    case 'postgres': return new PostgresWriter(uri, { schemaName: opts.schemaName });
    case 'mysql':    return new MySqlWriter(uri, { dbName: opts.dbName });
    default: throw new Error(`No CDC writer for engine "${engine}"`);
  }
}

// ─── queue (exported for route layer to enqueue jobs) ────────────────────────
export const cdcQueue = new Queue('cdc-sync', { connection: redis });

/**
 * Enqueue a CDC sync job. Idempotent — if a job with this jobId is already
 * active or waiting, nothing is added (deduplication via jobId as BullMQ id).
 *
 * Retry policy: CDC streams die for legitimate transient reasons (idle TLS
 * drops on Neon/Supabase free tiers, NAT timeouts, brief network blips).
 * The replication slot is preserved on the server, so reconnecting just
 * resumes from the last ACKed LSN — no data lost. We let BullMQ retry up
 * to 1000 times with exponential backoff (5s → 5min cap). Functionally
 * infinite for the lifetime of a sync; the user pauses/deletes to stop.
 */
export async function enqueueCdcSync(cdcSyncJobId: string): Promise<void> {
  await cdcQueue.add(
    'run',
    { cdcSyncJobId },
    {
      jobId: `cdc-${cdcSyncJobId}`,   // deterministic ID → deduplication
      removeOnComplete: false,         // keep for audit
      removeOnFail: false,
      attempts: 1000,
      backoff: { type: 'exponential', delay: 5000 },  // 5s, 10s, 20s, ... capped at ~5min
    },
  );
}

// ─── worker ──────────────────────────────────────────────────────────────────

export function startCdcWorker() {
  const worker = new Worker(
    'cdc-sync',
    async (job: Job<{ cdcSyncJobId: string }>) => {
      const { cdcSyncJobId } = job.data;

      const cdcJob = await prisma.cdcSyncJob.findUnique({
        where: { id: cdcSyncJobId },
        include: { source: true, destination: true },
      });
      if (!cdcJob || !cdcJob.enabled) {
        // Deleted or disabled while queued — silently discard.
        return;
      }

      // Honour pauseRequested at the top of every attempt. Without this,
      // BullMQ's retry-after-Neon-disconnect would silently resume the stream
      // even though the user clicked Pause — the in-loop check at line ~286
      // only fires between events, so a stream that's only seeing heartbeats
      // can never react to pause until Neon drops it and we retry.
      if (cdcJob.pauseRequested) {
        console.error(`[cdc-sync] job=${cdcSyncJobId} paused — exiting cleanly without starting stream`);
        await prisma.cdcSyncJob.update({
          where: { id: cdcSyncJobId },
          data: { status: 'paused', pauseRequested: false },
        });
        // Returning cleanly (no throw) → BullMQ marks the job completed and
        // does NOT schedule another retry. Resume re-enqueues fresh.
        return;
      }

      // "Already tailing" means the snapshot fully completed (or wasn't
      // required). cursor presence alone isn't enough — it gets persisted
      // BEFORE the snapshot starts, so a retry mid-snapshot has a cursor
      // but is still bootstrapping.
      const alreadyTailing =
        cdcJob.bootstrap !== 'snapshot' || cdcJob.snapshotState === 'done';

      const run = await prisma.cdcSyncRun.create({
        data: {
          jobId: cdcSyncJobId,
          profileId: cdcJob.profileId,
          phase: alreadyTailing ? 'tailing' : 'bootstrapping',
        },
      });

      await prisma.cdcSyncJob.update({
        where: { id: cdcSyncJobId },
        data: { status: alreadyTailing ? 'tailing' : 'bootstrapping' },
      });

      const srcUri = decrypt(cdcJob.source.encryptedUri);
      const dstUri = decrypt(cdcJob.destination.encryptedUri);

      const sourceFactory = CDC_SOURCE_REGISTRY.get(cdcJob.sourceType);
      if (!sourceFactory) {
        const msg = `CDC source adapter not yet implemented for engine "${cdcJob.sourceType}" (Phase 4B/4C/4D)`;
        await failRun(run.id, cdcSyncJobId, msg);
        throw new Error(msg);
      }

      const writer = makeWriter(cdcJob.destType, dstUri, {
        databaseOverride: cdcJob.destDatabase ?? undefined,
        schemaName:       cdcJob.destDatabase ?? undefined,
        dbName:           cdcJob.destDatabase ?? undefined,
      });

      if (!writer.applyChange) {
        const msg = `CDC writer for "${cdcJob.destType}" does not implement applyChange()`;
        await failRun(run.id, cdcSyncJobId, msg);
        throw new Error(msg);
      }

      // ── Bootstrap phase ──────────────────────────────────────────────────
      // If the job has never tailed before AND bootstrap === "snapshot":
      //   1. Capture the source's "current" cursor *before* the copy starts —
      //      this guarantees no events are lost in the gap between snapshot
      //      and tail. (Tail picks up everything that happened during the
      //      snapshot; redeliveries are absorbed by the writer's idempotent
      //      applyChange.)
      //   2. Run the migration pipeline to fully copy the data.
      //   3. Persist the cursor so a worker crash mid-bootstrap doesn't
      //      re-snapshot on restart.
      let startCursor: unknown = cdcJob.cursor;
      const needsSnapshot =
        cdcJob.bootstrap === 'snapshot' && cdcJob.snapshotState !== 'done';

      if (needsSnapshot) {
        // Capture (or reuse) the pre-snapshot cursor. On a retry the cursor is
        // already saved from the previous attempt — keep it so the tail still
        // starts BEFORE the original snapshot began (zero-gap guarantee).
        if (!startCursor) {
          const tempSource = sourceFactory({
            uri: srcUri,
            database: cdcJob.sourceDatabase ?? undefined,
            jobId: cdcSyncJobId,
          });
          startCursor = await tempSource.captureStartCursor();
          await tempSource.close();

          await prisma.cdcSyncJob.update({
            where: { id: cdcSyncJobId },
            data: { cursor: startCursor as object },
          });
        }

        try {
          const plan = buildPlanForPair({
            sourceType:     cdcJob.sourceType,
            destType:       cdcJob.destType,
            sourceUri:      srcUri,
            destUri:        dstUri,
            sourceDatabase: cdcJob.sourceDatabase,
            destDatabase:   cdcJob.destDatabase,
            dropExisting:   false,  // CDC bootstrap should not drop existing dest data
          });

          const nsFilter = (cdcJob.namespaces as Array<{ database: string; name: string }> | null) ?? undefined;

          const summary = await runMigration(plan.reader, plan.writer, plan.makeMapper, {
            sampleSize: 1000,
            batchSize: 1000,
            parallelism: 1,
            namespaces: nsFilter,
            database: plan.sourceDatabase,
          });

          // runMigration swallows per-namespace errors into summary.errors and
          // counts partial row failures in totalFailed without throwing. A
          // bootstrap that lost rows must NOT be marked done — otherwise the
          // worker would flip to tailing with a destination missing data.
          if (summary.failed > 0 || summary.totalFailed > 0 || summary.errors.length > 0) {
            const details = summary.errors
              .slice(0, 3)
              .map((e) => `${e.namespace.database}.${e.namespace.name}: ${e.error}`)
              .join(' | ');
            throw new Error(
              `Snapshot incomplete — ${summary.failed} namespace(s) failed, ` +
              `${summary.totalFailed} row(s) failed${details ? `: ${details}` : ''}`,
            );
          }
        } catch (snapErr) {
          const msg = `Snapshot bootstrap failed: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`;
          await failRun(run.id, cdcSyncJobId, msg);
          throw snapErr;
        }

        // Only NOW is it safe to skip the snapshot block on a future retry.
        await prisma.cdcSyncJob.update({
          where: { id: cdcSyncJobId },
          data: { snapshotState: 'done', status: 'tailing' },
        });
        await prisma.cdcSyncRun.update({
          where: { id: run.id },
          data: { phase: 'tailing' },
        });
      }

      // ── Open the change stream ────────────────────────────────────────────
      const source = sourceFactory({
        uri: srcUri,
        database: cdcJob.sourceDatabase ?? undefined,
        namespaces: cdcJob.namespaces as Array<{ database: string; name: string }> | undefined,
        jobId: cdcSyncJobId,
      });

      let inserts = 0, updates = 0, deletes = 0, errors = 0;

      console.error(`[cdc-sync] job=${cdcSyncJobId} entering for-await stream loop (startCursor=${JSON.stringify(startCursor)})`);

      // Clear any stale "Connection terminated unexpectedly" banner from a
      // previous BullMQ attempt. We've successfully made it back to the stream
      // loop on a fresh attempt — if the new attempt fails too, worker.on('failed')
      // will re-set lastError immediately. This is the UX fix that keeps the
      // sync card looking healthy whenever we're actually streaming, even on
      // cloud providers (Neon free tier) that drop the replication connection
      // every ~30s and force a reconnect.
      await prisma.cdcSyncJob.update({
        where: { id: cdcSyncJobId },
        data: { lastError: null },
      }).catch(() => { /* non-fatal — don't break stream startup over a DB write */ });

      try {
        for await (const event of source.stream({ startCursor })) {
          console.error(`[cdc-sync] job=${cdcSyncJobId} got event op=${event.op} ns=${event.ns.database}.${event.ns.name}`);
          // Check pause/disable between events (cooperative cancellation).
          const fresh = await prisma.cdcSyncJob.findUnique({
            where: { id: cdcSyncJobId },
            select: { pauseRequested: true, enabled: true },
          });
          if (!fresh || !fresh.enabled || fresh.pauseRequested) {
            await source.close();
            break;
          }

          try {
            await applyMappedChange(event, writer, cdcJob.sourceType, cdcJob.destType);

            // Update counts + cursor after every applied event.
            if (event.op === 'insert') inserts++;
            else if (event.op === 'update') updates++;
            else if (event.op === 'delete') deletes++;

            // Persist cursor + rolling counts.
            await prisma.cdcSyncJob.update({
              where: { id: cdcSyncJobId },
              data: {
                cursor: event.cursor as object,
                lastEventAt: new Date(),
                lastError: null,
              },
            });

            await prisma.cdcSyncRun.update({
              where: { id: run.id },
              data: { inserts, updates, deletes },
            });
          } catch (applyErr) {
            errors++;
            const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
            console.error(`[cdc-sync] applyChange failed for ${event.ns.database}.${event.ns.name}: ${msg}`);
            await prisma.cdcSyncJob.update({
              where: { id: cdcSyncJobId },
              data: { lastError: msg },
            });
            await prisma.cdcSyncRun.update({
              where: { id: run.id },
              data: { errorsCount: errors, lastError: msg },
            });
            // Continue — a single failed event shouldn't abort the whole stream.
          }
        }
      } finally {
        await source.close().catch(() => {});
        await writer.close().catch(() => {});
      }

      // Determine final status. The pause check has to include pauseRequested
      // because that's the flag the /pause route flips — `enabled` only goes
      // false on delete. Without this, a user-paused sync would land here with
      // status='tailing' even though we broke out of the loop for pause.
      const freshState = await prisma.cdcSyncJob.findUnique({
        where: { id: cdcSyncJobId },
        select: { enabled: true, pauseRequested: true },
      });
      const pausedOrDisabled = !freshState?.enabled || !!freshState?.pauseRequested;

      const finalStatus = pausedOrDisabled ? 'paused'
        : errors > 0 ? 'failed'
        : 'tailing';

      const cursorSnapshot = (await prisma.cdcSyncJob.findUnique({
        where: { id: cdcSyncJobId },
        select: { cursor: true },
      }))?.cursor;

      await prisma.cdcSyncRun.update({
        where: { id: run.id },
        data: {
          phase: finalStatus,
          finishedAt: new Date(),
          endCursor: cursorSnapshot ?? undefined,
        },
      });

      await prisma.cdcSyncJob.update({
        where: { id: cdcSyncJobId },
        data: { status: finalStatus, pauseRequested: false },
      });
    },
    {
      connection: redis,
      concurrency: 5,      // up to 5 simultaneous CDC streams
      lockDuration: 60_000, // 60 s lock; heartbeat via job.updateProgress()
    },
  );

  worker.on('failed', async (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const willRetry = attemptsMade < maxAttempts;
    console.error(`[CdcWorker] Job ${job?.id} attempt ${attemptsMade}/${maxAttempts} failed: ${err.message}${willRetry ? ' — will retry' : ' — giving up'}`);

    // Persist the transient error so the UI surfaces it — but keep status as
    // "tailing" while retries remain. Only flip to "failed" when BullMQ
    // exhausts attempts. The reconnect after backoff will resume from the
    // server-side slot, so no events are lost.
    const cdcSyncJobId = (job?.data as { cdcSyncJobId?: string } | undefined)?.cdcSyncJobId;
    if (cdcSyncJobId) {
      await prisma.cdcSyncJob.update({
        where: { id: cdcSyncJobId },
        data: {
          status: willRetry ? 'tailing' : 'failed',
          lastError: err.message,
        },
      }).catch((e) => console.error('[CdcWorker] failed to persist error:', e));
    }
  });

  return worker;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function failRun(runId: string, jobId: string, msg: string): Promise<void> {
  await prisma.cdcSyncRun.update({
    where: { id: runId },
    data: { phase: 'failed', finishedAt: new Date(), lastError: msg },
  });
  await prisma.cdcSyncJob.update({
    where: { id: jobId },
    data: { status: 'failed', lastError: msg },
  });
}

/**
 * Apply a ChangeEvent to the destination writer.
 *
 * For same-engine pairs, doc values pass through unchanged.
 * For cross-engine pairs, Phase 4B/4C/4D will thread the mapper here.
 * For now we pass doc through raw — correct for same-engine, "best effort"
 * for cross-engine until the mapper integration lands.
 */
async function applyMappedChange(
  event: ChangeEvent,
  writer: NamespaceWriter,
  _srcType: string,
  _dstType: string,
): Promise<void> {
  if (!writer.applyChange) throw new Error('Writer does not support applyChange');
  // TODO (4B/4C/4D): apply cross-engine mapper to event.doc before passing.
  await writer.applyChange(event);
}
