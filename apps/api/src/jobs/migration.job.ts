import { Worker } from 'bullmq';
import { redis } from '../lib/redis.js';
import { runMigration } from '../services/migration.service.js';

export function startMigrationWorker(emitLog: (jobId: string, phase: string, line: string) => void, emitComplete: (jobId: string) => void) {
  return new Worker('migration', async (job) => {
    const { migrationJobId } = job.data as { migrationJobId: string };
    await runMigration(migrationJobId, (phase, line) => {
      emitLog(migrationJobId, phase, line);
    });
    emitComplete(migrationJobId);
  }, { connection: redis, concurrency: 2 });
}
