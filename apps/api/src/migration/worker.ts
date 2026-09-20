import { Worker, type Job } from 'bullmq';
import type { Server as IOServer } from 'socket.io';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { buildMigrationPlan } from './service.js';
import { runMigration } from './pipeline.js';
import type { MigrationProgress, SchemaWarning } from './types.js';

const QUEUE_NAME = 'migration-v2';
const MAX_WARNINGS_PERSISTED = 500; // cap to keep the JSON column small

/**
 * Module-level reference to the running BullMQ worker so the rest of the API
 * (e.g. the Queue producer) can talk to the same instance without re-binding.
 */
let worker: Worker | null = null;

/** Start the migration-v2 worker. Idempotent — calls after the first are no-ops. */
export function startMigrationV2Worker(io: IOServer): Worker {
  if (worker) return worker;

  // ── Socket.io: room subscription for /migration-v2 ─────────────────────
  //
  // The worker emits per-run events with `io.of('/migration-v2').to(runId).emit(...)`.
  // Without this handler, clients would never join the room and miss every event.
  //
  // Protocol:
  //   client → socket.emit('subscribe', runId)
  //   server   joins the socket into a room named `runId`
  //   server → emits 'subscribed' { runId } as ack
  //   server → from here on, all worker events on that runId flow to the socket
  io.of('/migration-v2').on('connection', (socket) => {
    socket.on('subscribe', (runId: unknown) => {
      if (typeof runId !== 'string' || !runId) return;
      socket.join(runId);
      socket.emit('subscribed', { runId });
    });
    socket.on('unsubscribe', (runId: unknown) => {
      if (typeof runId === 'string') socket.leave(runId);
    });
  });

  worker = new Worker(
    QUEUE_NAME,
    async (job: Job<{ runId: string }>) => {
      await runMigrationJob(job.data.runId, io);
    },
    {
      connection: redis,
      // Migrations are long-lived; only one at a time per server to keep
      // memory + connection counts predictable.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[migration-v2] job ${job?.id} failed:`, err.message);
  });

  console.log(`[migration-v2] worker started on queue "${QUEUE_NAME}"`);
  return worker;
}

/** Stop the worker (called on app shutdown for clean disconnects). */
export async function stopMigrationV2Worker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

/**
 * Execute a single migration run.
 *
 * Persistence model:
 *   - One MigrationRunV2 row per execution.
 *   - On progress tick we update the `progress` JSON column (per-namespace
 *     state) AND emit a Socket.io event for live UI updates.
 *   - On warning we append to the `warnings` JSON array (capped) AND emit.
 *   - On terminal phase we finalise the row (phase, summary counts, errors).
 *
 * Cancellation:
 *   - The route POSTs `cancelRequested = true` on the run row.
 *   - We check that flag between batches (in the onProgress hook) and throw
 *     a CancelledError, which bubbles out of runMigration. The catch path
 *     marks the run `cancelled` and short-circuits cleanup.
 */
async function runMigrationJob(runId: string, io: IOServer): Promise<void> {
  const run = await prisma.migrationRunV2.findUniqueOrThrow({
    where: { id: runId },
    include: { job: true },
  });

  // Mark running.
  await prisma.migrationRunV2.update({
    where: { id: runId },
    data: { phase: 'running', startedAt: new Date() },
  });
  emit(io, runId, 'phase', { phase: 'running' });

  // Build plan from job row.
  let plan;
  try {
    plan = await buildMigrationPlan(run.jobId);
  } catch (err) {
    await finalise(runId, 'failed', { errorMessage: String(err) });
    emit(io, runId, 'phase', { phase: 'failed', error: String(err) });
    return;
  }

  // Local accumulators — persisted in batched updates rather than per-tick to
  // avoid hammering Postgres with 1000s of tiny writes during big migrations.
  const progressByNs = new Map<string, MigrationProgress>();
  const warnings: SchemaWarning[] = [];
  let writesSincePersist = 0;
  const PERSIST_EVERY = 25; // flush progress to DB every N ticks

  const persistProgress = async () => {
    await prisma.migrationRunV2.update({
      where: { id: runId },
      data: {
        progress: serialiseProgress(progressByNs) as unknown as object,
      },
    }).catch(() => { /* swallow — next tick will retry */ });
    writesSincePersist = 0;
  };

  try {
    const summary = await runMigration(
      plan.reader,
      plan.writer,
      plan.makeMapper,
      {
        database: plan.sourceDatabase,
        sampleSize: run.job.sampleSize,
        batchSize: run.job.batchSize,
        parallelism: run.job.parallelism,
        dryRun: run.dryRun,
        onProgress: (p) => {
          const key = `${p.namespace.database}.${p.namespace.name}`;
          progressByNs.set(key, p);
          // `key` is the stringified namespace (db.name) — handy for client lookups.
          // We send both the structured `namespace` (from p) and the flat `key`.
          emit(io, runId, 'progress', { key, ...p });
          writesSincePersist++;
          if (writesSincePersist >= PERSIST_EVERY) {
            void persistProgress(); // fire-and-forget
          }

          // Cooperative cancellation check — fast Redis-style poll via Prisma.
          // We don't want to read on every tick, so only when we'd persist anyway.
          if (writesSincePersist === 0) {
            void checkCancellation(runId).then((cancelled) => {
              if (cancelled) throw new CancelledError();
            }).catch(() => {});
          }
        },
        onWarning: (w) => {
          if (warnings.length < MAX_WARNINGS_PERSISTED) warnings.push(w);
          emit(io, runId, 'warning', w);
        },
      },
    );

    // Final flush.
    await persistProgress();

    // A run is "succeeded" only when EVERY signal is clean:
    //   • no namespaces threw      (summary.failed === 0)
    //   • no errors collected      (summary.errors.length === 0)
    //   • no row-level losses      (summary.totalFailed === 0)
    // If only some namespaces succeeded → partial. If none → failed.
    const totalNsRun = summary.succeeded + summary.failed;
    const phase =
      summary.failed === totalNsRun && totalNsRun > 0 ? 'failed' :
      (summary.failed > 0 || summary.errors.length > 0 || summary.totalFailed > 0) ? 'partial' :
      'succeeded';

    await finalise(runId, phase, {
      summary,
      warnings,
    });
    emit(io, runId, 'phase', { phase, summary });
  } catch (err) {
    const cancelled = err instanceof CancelledError;
    await finalise(runId, cancelled ? 'cancelled' : 'failed', {
      errorMessage: cancelled ? 'Cancelled by user' : String(err),
      warnings,
    });
    emit(io, runId, 'phase', {
      phase: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? 'Cancelled by user' : String(err),
    });
  }
}

/**
 * Cancellation polled via the DB. Cheap because cancellation is rare and we
 * check at most every PERSIST_EVERY ticks (~ once per 25 batches).
 */
async function checkCancellation(runId: string): Promise<boolean> {
  const r = await prisma.migrationRunV2.findUnique({
    where: { id: runId }, select: { cancelRequested: true },
  });
  return !!r?.cancelRequested;
}

class CancelledError extends Error {
  constructor() { super('Migration cancelled'); this.name = 'CancelledError'; }
}

async function finalise(
  runId: string,
  phase: 'succeeded' | 'partial' | 'failed' | 'cancelled',
  data: { summary?: import('./pipeline.js').MigrationSummary; warnings?: SchemaWarning[]; errorMessage?: string },
): Promise<void> {
  const s = data.summary;
  await prisma.migrationRunV2.update({
    where: { id: runId },
    data: {
      phase,
      finishedAt: new Date(),
      totalNamespaces: s?.namespaces ?? 0,
      succeededNs: s?.succeeded ?? 0,
      failedNs: s?.failed ?? 0,
      totalWritten: s?.totalWritten ?? 0,
      totalSkipped: s?.totalSkipped ?? 0,
      totalFailed: s?.totalFailed ?? 0,
      warnings: (data.warnings ?? []) as unknown as object,
      errors: (s?.errors ?? (data.errorMessage ? [{ namespace: null, error: data.errorMessage }] : [])) as unknown as object,
    },
  });
}

function serialiseProgress(map: Map<string, MigrationProgress>): Record<string, MigrationProgress> {
  const out: Record<string, MigrationProgress> = {};
  for (const [k, v] of map.entries()) out[k] = v;
  return out;
}

/** Emit on the per-run namespace. Clients subscribe with `io.of('/migration-v2').to(runId)`. */
function emit(io: IOServer, runId: string, event: string, payload: unknown): void {
  io.of('/migration-v2').to(runId).emit(event, payload);
}

export const MIGRATION_V2_QUEUE_NAME = QUEUE_NAME;
