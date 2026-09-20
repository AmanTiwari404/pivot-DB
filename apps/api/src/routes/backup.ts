import { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { rm, access } from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { backupQueue, restoreQueue } from '../lib/queue.js';
import { profileScope, requireAdmin } from '../plugins/auth.js';
import { scheduleBackupJob, reloadBackupJob, unscheduleBackupJob } from '../scheduler/index.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const CreateJobBody = z.object({
  name: z.string().min(1),
  connectionId: z.string(),
  databases: z.array(z.string()).default([]),
  schedule: z.string().min(1),
  retentionDays: z.number().int().positive().default(30),
});

const RestoreBody = z.object({
  targetConnectionId: z.string().min(1),
});

const PatchJobBody = z.object({
  name: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  databases: z.array(z.string()).optional(),
  retentionDays: z.number().int().positive().optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export async function backupRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // ── List jobs ─────────────────────────────────────────────────────────────
  app.get('/jobs', opts, async (req) => {
    const scope = profileScope(req);
    return prisma.backupJob.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      include: { connection: { select: { name: true } } },
    });
  });

  // ── Create job ────────────────────────────────────────────────────────────
  app.post('/jobs', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateJobBody.parse(req.body);
    const user = req.user as JWTUser;

    let profileId = user.profileId;
    if (!profileId) {
      const conn = await prisma.connection.findUnique({ where: { id: body.connectionId }, select: { profileId: true } });
      profileId = conn?.profileId ?? null;
    }
    if (!profileId) return reply.code(400).send({ error: 'No profile assigned' });

    const job = await prisma.backupJob.create({
      data: {
        name: body.name,
        connectionId: body.connectionId,
        profileId,
        databases: body.databases,
        schedule: body.schedule,
        retentionDays: body.retentionDays,
        status: 'active',
      },
    });
    // Register repeatable job in BullMQ/Redis so the schedule fires without a server restart
    await scheduleBackupJob({ id: job.id, schedule: job.schedule });
    return reply.code(201).send(job);
  });

  // ── Update job (pause / resume / reschedule) ──────────────────────────────
  app.patch('/jobs/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = PatchJobBody.parse(req.body);
    const scope = profileScope(req);

    const existing = await prisma.backupJob.findFirst({ where: { id, ...scope } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const updated = await prisma.backupJob.update({ where: { id }, data: body });
    // Update the BullMQ repeatable job to match the new schedule/status
    await reloadBackupJob({ id: updated.id, schedule: updated.schedule, status: updated.status });
    return updated;
  });

  // ── Delete job + all files ────────────────────────────────────────────────
  app.delete('/jobs/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const scope = profileScope(req);
    const user = req.user as JWTUser;

    const existing = await prisma.backupJob.findFirst({ where: { id, ...scope } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    // Delete all backup files from disk first
    const runs = await prisma.backupRun.findMany({ where: { jobId: id }, select: { filePath: true } });
    for (const run of runs) {
      if (run.filePath) await rm(run.filePath, { force: true });
    }

    // Remove the BullMQ repeatable job so it stops firing
    await unscheduleBackupJob(id);
    // Cascade deletes BackupRun rows automatically
    await prisma.backupJob.delete({ where: { id } });

    await prisma.auditEvent.create({
      data: {
        actor: user.email,
        action: 'delete_backup',
        target: `backup_job:${id}`,
        metadata: { name: existing.name, connectionId: existing.connectionId },
      },
    });

    return reply.code(204).send();
  });

  // ── Trigger immediate run ─────────────────────────────────────────────────
  app.post('/jobs/:id/run', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const scope = profileScope(req);

    const job = await prisma.backupJob.findFirst({ where: { id, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    await backupQueue.add('run', { backupJobId: id }, {
      jobId: `backup-manual-${id}-${Date.now()}`,
    });
    return { queued: true };
  });

  // ── List runs for a job ───────────────────────────────────────────────────
  app.get('/jobs/:id/runs', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);

    const job = await prisma.backupJob.findFirst({ where: { id, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    return prisma.backupRun.findMany({
      where: { jobId: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  });

  // ── Download a backup file ────────────────────────────────────────────────
  app.get('/runs/:runId/download', opts, async (req, reply) => {
    const { runId } = req.params as { runId: string };

    const run = await prisma.backupRun.findUnique({
      where: { id: runId },
      include: { job: { select: { profileId: true } } },
    });

    if (!run || !run.filePath) return reply.code(404).send({ error: 'Not found' });

    // Profile isolation check
    const user = req.user as JWTUser;
    if (user.role !== 'superadmin' && run.job.profileId !== user.profileId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (run.status !== 'success') return reply.code(400).send({ error: 'Run not successful' });

    try {
      await access(run.filePath);
    } catch {
      return reply.code(404).send({ error: 'Backup file not found on disk' });
    }

    const filename = `backup-${runId}${run.filePath.endsWith('.enc') ? '.tar.gz.enc' : '.tar.gz'}`;
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(createReadStream(run.filePath));
  });

  // ── Trigger a restore from a backup run ───────────────────────────────────
  app.post('/runs/:runId/restore', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { runId } = req.params as { runId: string };
    const body = RestoreBody.parse(req.body);
    const user = req.user as JWTUser;

    // 1. Find BackupRun + parent job
    const run = await prisma.backupRun.findUnique({
      where: { id: runId },
      include: { job: { select: { profileId: true } } },
    });
    if (!run) return reply.code(404).send({ error: 'Backup run not found' });

    // 2. Profile isolation
    const profileId = user.role === 'superadmin' ? run.job.profileId : user.profileId;
    if (user.role !== 'superadmin' && run.job.profileId !== user.profileId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    if (!profileId) return reply.code(400).send({ error: 'No profile assigned' });

    // 3. Status + file checks
    if (run.status !== 'success') {
      return reply.code(400).send({ error: 'Backup run did not complete successfully' });
    }
    if (!run.filePath) {
      return reply.code(400).send({ error: 'Backup file path missing' });
    }
    try {
      await access(run.filePath);
    } catch {
      return reply.code(404).send({ error: 'Backup file not found on disk' });
    }

    // 4. Verify target connection belongs to this profile
    const target = await prisma.connection.findFirst({
      where: { id: body.targetConnectionId, profileId },
      select: { id: true },
    });
    if (!target) return reply.code(404).send({ error: 'Target connection not found' });

    // 5. Concurrent-restore guard
    const inflight = await prisma.restoreRun.findFirst({
      where: { backupRunId: runId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (inflight) {
      return reply.code(409).send({ error: 'A restore is already in progress for this backup' });
    }

    // 6. Create RestoreRun
    const record = await prisma.restoreRun.create({
      data: {
        backupRunId: runId,
        targetConnectionId: body.targetConnectionId,
        profileId,
        status: 'queued',
      },
    });

    // 7. Enqueue
    await restoreQueue.add(
      'run',
      { restoreRunId: record.id },
      { jobId: `restore-${record.id}` },
    );

    await prisma.auditEvent.create({
      data: {
        actor: user.email,
        action: 'restore_backup',
        target: `backup_run:${runId}`,
        metadata: {
          restoreRunId: record.id,
          targetConnectionId: body.targetConnectionId,
        },
      },
    });

    return reply.code(202).send({ restoreRunId: record.id, status: 'queued' });
  });

  // ── Poll a single restore run ─────────────────────────────────────────────
  app.get('/restore/:restoreRunId', opts, async (req, reply) => {
    const { restoreRunId } = req.params as { restoreRunId: string };
    const user = req.user as JWTUser;

    const restoreRun = await prisma.restoreRun.findUnique({
      where: { id: restoreRunId },
      include: {
        backupRun: { select: { id: true, startedAt: true, sizeBytes: true, jobId: true } },
        targetConnection: { select: { id: true, name: true } },
      },
    });
    if (!restoreRun) return reply.code(404).send({ error: 'Not found' });

    if (user.role !== 'superadmin' && restoreRun.profileId !== user.profileId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return restoreRun;
  });

  // ── Restore history for a backup job ──────────────────────────────────────
  app.get('/jobs/:id/restores', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);

    const job = await prisma.backupJob.findFirst({ where: { id, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    return prisma.restoreRun.findMany({
      where: { backupRun: { jobId: id } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        backupRun: { select: { id: true, startedAt: true, sizeBytes: true } },
        targetConnection: { select: { id: true, name: true } },
      },
    });
  });

  // ── All restore runs across all jobs in the profile (for Catalog tab) ─────
  app.get('/restores', opts, async (req) => {
    const user = req.user as JWTUser;
    const where = user.role === 'superadmin' ? {} : { profileId: user.profileId ?? '__none__' };

    return prisma.restoreRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        backupRun: {
          select: {
            id: true,
            startedAt: true,
            sizeBytes: true,
            job: { select: { id: true, name: true } },
          },
        },
        targetConnection: { select: { id: true, name: true } },
      },
    });
  });
}
