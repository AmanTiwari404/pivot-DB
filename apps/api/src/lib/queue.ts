import { Queue } from 'bullmq';
import { redis } from './redis.js';

const connection = redis;

export const exportQueue    = new Queue('export',    { connection });
export const backupQueue    = new Queue('backup',    { connection });
export const restoreQueue   = new Queue('restore',   { connection });
export const migrationQueue = new Queue('migration', { connection });
// Phase 1C — cross-engine migration (separate queue so we can run alongside
// the legacy mongodump-based migrationQueue without contention).
export const migrationV2Queue = new Queue('migration-v2', { connection });
