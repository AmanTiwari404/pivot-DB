import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { backupQueue } from '../lib/queue.js';
import { evaluateAlerts } from '../lib/alertEvaluator.js';
import { getSnapshot, type MonitorSnapshot } from '../services/monitor.service.js';
import { getSqlMonitorSnapshot, type SqlMonitorSnapshot } from '../services/sql-monitor.service.js';

// Timezone used when interpreting all cron expressions.
// Set SCHEDULER_TZ in your .env to change it (e.g. "Asia/Kolkata", "America/New_York").
// Defaults to UTC so schedules are server-timezone-independent.
const SCHEDULER_TZ = process.env.SCHEDULER_TZ ?? 'UTC';

// ── Backup scheduling via BullMQ repeatable jobs ──────────────────────────────
// BullMQ stores repeatable jobs in Redis (persistent, survives restarts).
// This is more reliable than in-memory node-cron tasks which can ghost-fire
// after a schedule change if stop()/destroy() races with the event loop.

export async function scheduleBackupJob(job: { id: string; schedule: string }) {
  await unscheduleBackupJob(job.id); // remove any existing repeatable for this job

  if (!cron.validate(job.schedule)) {
    console.warn(`[scheduler] Invalid cron for backup job ${job.id}: ${job.schedule}`);
    return;
  }

  await backupQueue.add(
    'run',
    { backupJobId: job.id },
    {
      repeat: { pattern: job.schedule, tz: SCHEDULER_TZ },
      // Embed the backup-job ID so we can find + remove it later
      jobId: `backup-repeat-${job.id}`,
    },
  );

  console.log(`[scheduler] scheduled backup job ${job.id} → ${job.schedule} (tz: ${SCHEDULER_TZ})`);
}

export async function unscheduleBackupJob(jobId: string) {
  const repeatableJobs = await backupQueue.getRepeatableJobs();
  for (const r of repeatableJobs) {
    // Match by the jobId we embedded OR by key containing the job id
    if (r.id === `backup-repeat-${jobId}` || r.key.includes(jobId)) {
      await backupQueue.removeRepeatableByKey(r.key);
      console.log(`[scheduler] removed repeatable backup job ${jobId}`);
    }
  }
}

export async function reloadBackupJob(job: { id: string; schedule: string; status: string }) {
  if (job.status === 'active') {
    await scheduleBackupJob(job);
  } else {
    await unscheduleBackupJob(job.id);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export async function startScheduler() {
  // Background alert evaluation safety net (every 30s).
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const profiles = await prisma.alertRule.groupBy({
        by: ['connectionId', 'profileId'],
        where: { enabled: true, status: { not: 'paused' } },
      });
      for (const { connectionId, profileId } of profiles) {
        try {
          const snapshot = await snapshotForAlertEval(connectionId);
          if (!snapshot) continue;
          await evaluateAlerts(connectionId, profileId, snapshot);
        } catch (err) {
          console.error(`[scheduler] alert eval ${connectionId}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[scheduler] alert sweep error:', (err as Error).message);
    }
  });

  // ── Register backup jobs as BullMQ repeatable jobs on startup ────────────────
  const activeBackups = await prisma.backupJob.findMany({
    where: { status: 'active' },
    select: { id: true, schedule: true },
  });

  const activeIds = new Set(activeBackups.map(j => j.id));

  // Prune stale repeatable jobs from Redis that no longer exist in DB
  const existing = await backupQueue.getRepeatableJobs();
  for (const r of existing) {
    if (!r.id) continue;
    const match = r.id.match(/^backup-repeat-(.+)$/);
    if (match && !activeIds.has(match[1])) {
      await backupQueue.removeRepeatableByKey(r.key);
      console.log(`[scheduler] pruned stale repeatable job ${r.id}`);
    }
  }

  // Schedule all active backup jobs
  for (const job of activeBackups) {
    await scheduleBackupJob(job);
  }

  console.log(`[scheduler] started — ${activeBackups.length} backup job(s) registered`);
}

// ── Alert snapshot dispatch ─────────────────────────────────────────────────
// Alerts originally only worked for MongoDB. To support Postgres/MySQL we
// fetch the engine-appropriate snapshot then adapt the SQL shape into the
// MonitorSnapshot shape the evaluator already understands. Metrics that
// don't apply to SQL (memResident, memVirtual, wtCacheUsedMB) come through
// as 0 and the evaluator skips them via `value === null` short-circuits.

async function snapshotForAlertEval(connectionId: string): Promise<MonitorSnapshot | null> {
  const conn = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { dbType: true },
  });
  if (!conn) return null;

  if (conn.dbType === 'mongodb') {
    return getSnapshot(connectionId);
  }
  if (conn.dbType === 'postgres' || conn.dbType === 'mysql') {
    const sql = await getSqlMonitorSnapshot(connectionId);
    return adaptSqlSnapshot(sql);
  }
  return null;
}

/**
 * Translate an SqlMonitorSnapshot into the MonitorSnapshot shape so the
 * existing Mongo-shaped alert evaluator can run unchanged. Only the fields
 * the evaluator reads need real values; everything else gets a safe default.
 *
 * Metric mapping (alert rule metric → SQL field):
 *   currentConnections   → connections.current
 *   availableConnections → max - current (or 0 if max unknown)
 *   opsPerSecTotal       → transactionsPerSec OR queriesPerSec, whichever is set
 *   wtCachePercent       → cacheHitRatio * 100 (PG buffer cache / MySQL InnoDB BP)
 *   replicationLag       → replication.lagSeconds when isReplica
 *   memResident / memVirtual / networkBytesIn/Out → null (skipped)
 */
function adaptSqlSnapshot(sql: SqlMonitorSnapshot): MonitorSnapshot {
  const tps = sql.throughput.transactionsPerSec ?? 0;
  const qps = sql.throughput.queriesPerSec ?? 0;
  const cacheRatio = sql.throughput.cacheHitRatio;
  // The MonitorSnapshot evaluator calculates wtCachePercent as used/max*100,
  // so we encode the ratio directly: max=100, used=ratio*100.
  const wtCacheMaxMB = 100;
  const wtCacheUsedMB = cacheRatio !== null ? cacheRatio * 100 : 0;

  const availableConnections =
    sql.connections.max !== null
      ? Math.max(0, sql.connections.max - sql.connections.current)
      : 0;

  return {
    host: '',
    version: sql.version,
    uptime: sql.uptimeSeconds,
    storageEngine: '',
    currentConnections: sql.connections.current,
    availableConnections,
    totalConnectionsCreated: 0,
    opsPerSec: {
      insert: 0, query: qps, update: 0, delete: 0, getmore: 0, command: tps,
    },
    memResident: 0,
    memVirtual: 0,
    networkBytesIn: 0,
    networkBytesOut: 0,
    networkRequests: 0,
    wtCacheUsedMB,
    wtCacheMaxMB,
    wtCacheHitRatio: cacheRatio ?? 0,
    docsRead: 0,
    docsInserted: 0,
    docsUpdated: 0,
    docsDeleted: 0,
    replicaSet: sql.replication && sql.replication.isReplica
      ? {
          name: 'sql-replica',
          myState: 2,
          myStateName: 'SECONDARY',
          members: [{
            name: '',
            state: 2,
            stateName: 'SECONDARY',
            health: 1,
            lagSeconds: sql.replication.lagSeconds,
            self: true,
          }],
        }
      : null,
    activeAlerts: 0,
    timestamp: new Date().toISOString(),
  };
}
