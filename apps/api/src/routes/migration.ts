import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { migrationQueue } from '../lib/queue.js';
import { profileScope, requireAdmin } from '../plugins/auth.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const CreateMigrationBody = z.object({
  name: z.string().min(1),
  sourceConnId: z.string(),
  destConnId: z.string(),
  scope: z.object({
    all: z.boolean().optional(),
    databases: z.array(z.string()).optional(),
  }).default({ all: true }),
  options: z.object({
    dropDestination: z.boolean().default(false),
    dropAllDestination: z.boolean().default(false),
    preserveUsers: z.boolean().default(false),
    oplog: z.boolean().default(false),
    gzip: z.boolean().default(true),
    numParallelCollections: z.number().min(1).max(16).default(4),
  }).default({}),
});

export async function migrationRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  app.post('/', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateMigrationBody.parse(req.body);
    const user = req.user as JWTUser;
    // Superadmins have no profileId — resolve from source connection
    let profileId = user.profileId;
    if (!profileId) {
      const conn = await prisma.connection.findUnique({ where: { id: body.sourceConnId }, select: { profileId: true } });
      profileId = conn?.profileId ?? null;
    }
    if (!profileId) return reply.code(400).send({ error: 'No profile assigned' });

    const job = await prisma.migrationJob.create({
      data: {
        name: body.name,
        sourceConnId: body.sourceConnId,
        destConnId: body.destConnId,
        profileId,
        scope: body.scope as object,
        options: body.options as object,
        status: 'pending',
        createdBy: user.email,
      },
    });

    await migrationQueue.add('migration', { migrationJobId: job.id });

    await prisma.auditEvent.create({
      data: {
        actor: user.email,
        action: 'create_migration',
        target: `migration_job:${job.id}`,
        metadata: {
          name: body.name,
          sourceConnId: body.sourceConnId,
          destConnId: body.destConnId,
        },
      },
    });

    return reply.code(201).send(job);
  });

  // Preflight check — validate connections exist and source is reachable
  app.post('/preflight', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { sourceConnId, destConnId } = z.object({
      sourceConnId: z.string(),
      destConnId: z.string(),
    }).parse(req.body);
    const scope = profileScope(req);

    const [src, dst] = await Promise.all([
      prisma.connection.findFirst({ where: { id: sourceConnId, ...scope } }),
      prisma.connection.findFirst({ where: { id: destConnId, ...scope } }),
    ]);

    const checks: Array<{ label: string; status: 'ok' | 'warn' | 'error'; message: string }> = [];

    checks.push({
      label: 'Source connection found',
      status: src ? 'ok' : 'error',
      message: src ? src.name : 'Connection not found or not accessible',
    });

    checks.push({
      label: 'Destination connection found',
      status: dst ? 'ok' : 'error',
      message: dst ? dst.name : 'Connection not found or not accessible',
    });

    if (dst?.readOnly) {
      checks.push({ label: 'Destination writable', status: 'error', message: 'Destination connection is marked read-only' });
    } else if (dst) {
      checks.push({ label: 'Destination writable', status: 'ok', message: 'Destination is writable' });
    }

    if (src && dst && src.id === dst.id) {
      checks.push({ label: 'Source ≠ Destination', status: 'error', message: 'Source and destination must be different connections' });
    } else if (src && dst) {
      checks.push({ label: 'Source ≠ Destination', status: 'ok', message: 'Connections are different' });
    }

    checks.push({
      label: 'mongodump available',
      status: 'warn',
      message: 'Assumes mongodump/mongorestore are installed on the server',
    });

    const hasError = checks.some((c) => c.status === 'error');
    return { ok: !hasError, checks };
  });

  app.get('/', opts, async (req) => {
    const scope = profileScope(req);
    return prisma.migrationJob.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      include: { source: { select: { name: true } }, destination: { select: { name: true } } },
    });
  });

  app.get('/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const job = await prisma.migrationJob.findFirst({
      where: { id: jobId, ...scope },
      include: {
        source: { select: { name: true } },
        destination: { select: { name: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return job;
  });

  app.get('/:jobId/runs', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const job = await prisma.migrationJob.findFirst({ where: { id: jobId, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return prisma.migrationRun.findMany({
      where: { jobId },
      orderBy: { startedAt: 'desc' },
    });
  });
}
