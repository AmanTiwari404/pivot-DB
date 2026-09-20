import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';

import authPlugin from './plugins/auth.js';
import socketioPlugin from './plugins/socketio.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { connectionRoutes } from './routes/connections.js';
import { exploreRoutes } from './routes/explore.js';
import { monitorRoutes, registerMonitorSocket } from './routes/monitor.js';
import { exportRoutes } from './routes/export.js';
import { cdcSyncRoutes } from './routes/cdc-sync.js';
import { backupRoutes } from './routes/backup.js';
import { alertRoutes } from './routes/alerts.js';
import { migrationRoutes } from './routes/migration.js';
import { migrationV2Routes } from './routes/migration-v2.js';
import { startMigrationV2Worker } from './migration/worker.js';
import { startExportWorker } from './jobs/export.job.js';
import { startCdcWorker } from './jobs/cdc-sync.job.js';
import { startBackupWorker } from './jobs/backup.job.js';
import { startRestoreWorker } from './jobs/restore.job.js';
import { startMigrationWorker } from './jobs/migration.job.js';
import { startScheduler } from './scheduler/index.js';
import { prisma } from './lib/prisma.js';
import { closeAllClients } from './lib/mongo.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
  // BigInt (e.g. sizeBytes on BackupRun) is not natively serializable by JSON
  serializerOpts: {
    rounding: 'round',
  },
});

// Serialize BigInt as a regular number in all JSON responses
app.addHook('preSerialization', async (_req, _reply, payload) => {
  return JSON.parse(JSON.stringify(payload, (_k, v) =>
    typeof v === 'bigint' ? Number(v) : v
  ));
});

// Core plugins
await app.register(cors, { origin: true });
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(authPlugin);
await app.register(socketioPlugin);

// Routes at root level (no prefix, no auth)
await app.register(healthRoutes);
await app.register(metricsRoutes);

// API routes
await app.register(async (api) => {
  await api.register(fp(async (sub: typeof api) => {
    await sub.register(connectionRoutes, { prefix: '/connections' });
    await sub.register(exploreRoutes,    { prefix: '/connections' });
    await sub.register(monitorRoutes,    { prefix: '/connections' });
    await sub.register(exportRoutes,     { prefix: '/export' });
    // CDC sync (Phase 4). Continuous, resumable replication — supersedes
    // the legacy batch /sync (Mongo-only cron re-copy), which was removed.
    await sub.register(cdcSyncRoutes,    { prefix: '/cdc-sync' });
    await sub.register(backupRoutes,     { prefix: '/backup' });
    await sub.register(alertRoutes,      { prefix: '/alerts' });
    await sub.register(migrationRoutes,   { prefix: '/migration' });
    // Cross-engine migration (Phase 1C+). Separate prefix from the legacy
    // mongodump-based /api/migration so both flows can coexist.
    await sub.register(migrationV2Routes, { prefix: '/migration-v2' });
  }));
}, { prefix: '/api' });

// Settings route (inline for brevity)
app.get('/api/settings/audit', { preHandler: [app.authenticate] }, async (req) => {
  const { page = 1, pageSize = 50, action, actor } = req.query as {
    page?: number; pageSize?: number; action?: string; actor?: string;
  };
  const skip = (Number(page) - 1) * Number(pageSize);
  const where: Record<string, unknown> = {};
  if (action) where['action'] = action;
  if (actor) where['actor'] = actor;
  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { timestamp: 'desc' }, skip, take: Number(pageSize) }),
    prisma.auditEvent.count({ where }),
  ]);
  return { events, total, page: Number(page), pageSize: Number(pageSize) };
});

app.get('/api/settings/users', { preHandler: [app.authenticate] }, async () => {
  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true, createdAt: true } });
  return users;
});

app.delete('/api/settings/users/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
  const { id } = req.params as { id: string };
  await prisma.user.delete({ where: { id } });
  return reply.code(204).send();
});

// Socket.IO for monitor
registerMonitorSocket(app);

// Start BullMQ workers
startExportWorker();
startCdcWorker();
startBackupWorker();
startRestoreWorker();

// Migration worker — emits socket events on progress
const io = (app as unknown as { io: { emit: (ev: string, ...args: unknown[]) => void } }).io;
startMigrationWorker(
  (jobId, phase, line) => { try { io?.emit(`migration:log:${jobId}`, { phase, line }); } catch (_) { /* noop */ } },
  (jobId) => { try { io?.emit(`migration:done:${jobId}`, {}); } catch (_) { /* noop */ } },
);

// Cross-engine migration worker (Phase 1C). Uses Socket.io namespaces for
// per-run progress streams — see src/migration/worker.ts.
startMigrationV2Worker(app.io);

// Start scheduler (async — loads backup jobs from DB on startup)
await startScheduler();

// Graceful shutdown
const shutdown = async () => {
  await app.close();
  await closeAllClients();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[api] listening on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
