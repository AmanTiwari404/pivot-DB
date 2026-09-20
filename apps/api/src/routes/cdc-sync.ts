/**
 * CDC Sync routes — Phase 4 (Fastify)
 *
 * POST   /api/cdc-sync           create a new CdcSyncJob (auto-enqueues)
 * GET    /api/cdc-sync           list all CdcSyncJobs for this profile
 * GET    /api/cdc-sync/:id       get one job + its last 20 runs
 * PATCH  /api/cdc-sync/:id       update (enable/disable, edit name/namespaces, etc.)
 * DELETE /api/cdc-sync/:id       delete job (also removes any queued BullMQ entry)
 * POST   /api/cdc-sync/:id/start enqueue (or re-enqueue) the CDC worker
 * POST   /api/cdc-sync/:id/pause set pauseRequested = true (worker drains)
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { enqueueCdcSync, cdcQueue } from '../jobs/cdc-sync.job.js';
import { requireAdmin } from '../plugins/auth.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const NamespaceSchema = z.object({
  database: z.string(),
  name: z.string(),
});

const CreateBody = z.object({
  name: z.string().min(1),
  sourceConnId: z.string(),
  destConnId: z.string(),
  sourceDatabase: z.string().optional(),
  destDatabase: z.string().optional(),
  namespaces: z.array(NamespaceSchema).optional(),
  schemaMapping: z.unknown().optional(),
  typeMappingRules: z.unknown().optional(),
  bootstrap: z.enum(['snapshot', 'tail']).default('snapshot'),
});

const UpdateBody = z.object({
  name: z.string().optional(),
  namespaces: z.array(NamespaceSchema).optional(),
  schemaMapping: z.unknown().optional(),
  typeMappingRules: z.unknown().optional(),
  sourceDatabase: z.string().optional(),
  destDatabase: z.string().optional(),
  enabled: z.boolean().optional(),
});

export async function cdcSyncRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // ── list ───────────────────────────────────────────────────────────────────
  app.get('/', opts, async (req) => {
    const user = req.user as JWTUser;
    if (!user.profileId) return [];
    return prisma.cdcSyncJob.findMany({
      where: { profileId: user.profileId },
      orderBy: { createdAt: 'desc' },
      include: {
        source:      { select: { id: true, name: true, dbType: true } },
        destination: { select: { id: true, name: true, dbType: true } },
        runs:        { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
  });

  // ── get one ────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', opts, async (req, reply) => {
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(404).send({ error: 'Not found' });
    const job = await prisma.cdcSyncJob.findFirst({
      where: { id: req.params.id, profileId: user.profileId },
      include: {
        source:      { select: { id: true, name: true, dbType: true } },
        destination: { select: { id: true, name: true, dbType: true } },
        runs:        { orderBy: { startedAt: 'desc' }, take: 20 },
      },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return job;
  });

  // ── create ─────────────────────────────────────────────────────────────────
  app.post('/', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(400).send({ error: 'No profile assigned' });

    const body = CreateBody.parse(req.body);
    if (body.sourceConnId === body.destConnId) {
      return reply.code(400).send({ error: 'Source and destination cannot be the same connection' });
    }

    // Resolve source + dest engines from existing connections.
    const [src, dst] = await Promise.all([
      prisma.connection.findFirst({
        where: { id: body.sourceConnId, profileId: user.profileId },
        select: { dbType: true },
      }),
      prisma.connection.findFirst({
        where: { id: body.destConnId, profileId: user.profileId },
        select: { dbType: true, readOnly: true },
      }),
    ]);
    if (!src) return reply.code(400).send({ error: 'Source connection not found' });
    if (!dst) return reply.code(400).send({ error: 'Destination connection not found' });
    if (dst.readOnly) return reply.code(400).send({ error: 'Destination connection is read-only' });

    const job = await prisma.cdcSyncJob.create({
      data: {
        name:             body.name,
        profileId:        user.profileId,
        sourceConnId:     body.sourceConnId,
        destConnId:       body.destConnId,
        sourceType:       src.dbType,
        destType:         dst.dbType,
        sourceDatabase:   body.sourceDatabase,
        destDatabase:     body.destDatabase,
        namespaces:       (body.namespaces ?? undefined) as object | undefined,
        schemaMapping:    (body.schemaMapping ?? undefined) as object | undefined,
        typeMappingRules: (body.typeMappingRules ?? undefined) as object | undefined,
        bootstrap:        body.bootstrap,
        status:           'queued',
        createdBy:        user.userId,
      },
    });

    await enqueueCdcSync(job.id);
    return reply.code(201).send(job);
  });

  // ── update ─────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(404).send({ error: 'Not found' });

    const existing = await prisma.cdcSyncJob.findFirst({
      where: { id: req.params.id, profileId: user.profileId },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const body = UpdateBody.parse(req.body);
    return prisma.cdcSyncJob.update({
      where: { id: req.params.id },
      data: body as Record<string, unknown>,
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(404).send({ error: 'Not found' });

    const existing = await prisma.cdcSyncJob.findFirst({
      where: { id: req.params.id, profileId: user.profileId },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    // Best-effort remove from BullMQ if it's still waiting.
    const bJob = await cdcQueue.getJob(`cdc-${req.params.id}`);
    if (bJob) {
      const state = await bJob.getState();
      if (state === 'waiting' || state === 'delayed') await bJob.remove();
    }

    // Mark disabled so an active worker drains, then delete the row.
    // (CdcSyncRun cascades on delete.)
    await prisma.cdcSyncJob.update({
      where: { id: req.params.id },
      data: { enabled: false, pauseRequested: true },
    });
    await prisma.cdcSyncJob.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });

  // ── start / re-enqueue ─────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/start', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(404).send({ error: 'Not found' });

    const job = await prisma.cdcSyncJob.findFirst({
      where: { id: req.params.id, profileId: user.profileId },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    await prisma.cdcSyncJob.update({
      where: { id: req.params.id },
      data: { enabled: true, pauseRequested: false, status: 'queued' },
    });

    // BullMQ uses deterministic job IDs (`cdc-${id}`) for dedup. If a previous
    // run completed or failed, re-add() silently no-ops. Remove the stale job
    // first so Resume actually queues a fresh attempt.
    const oldBJob = await cdcQueue.getJob(`cdc-${job.id}`);
    if (oldBJob) {
      const state = await oldBJob.getState();
      if (state === 'completed' || state === 'failed') {
        await oldBJob.remove().catch(() => { /* tolerate race */ });
      }
    }
    await enqueueCdcSync(job.id);
    return { queued: true };
  });

  // ── pause ──────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/pause', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(404).send({ error: 'Not found' });

    const job = await prisma.cdcSyncJob.findFirst({
      where: { id: req.params.id, profileId: user.profileId },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    await prisma.cdcSyncJob.update({
      where: { id: req.params.id },
      data: { pauseRequested: true },
    });

    // Remove the BullMQ job if it's waiting/delayed — otherwise our 5-30s
    // exponential backoff would re-fire the worker after the user paused.
    // For an actively running attempt we can't cancel mid-stream; the worker
    // will exit on its own when the current Neon connection drops and the
    // top-of-worker pauseRequested check kicks in on the next pickup.
    const bJob = await cdcQueue.getJob(`cdc-${req.params.id}`);
    if (bJob) {
      const state = await bJob.getState();
      if (state === 'waiting' || state === 'delayed') {
        await bJob.remove().catch(() => { /* race with retry — fine */ });
      }
    }

    return { pausing: true };
  });
}
