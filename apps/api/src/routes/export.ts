import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { exportQueue } from '../lib/queue.js';
import { profileScope, requireAdmin } from '../plugins/auth.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const CreateExportBody = z.object({
  connectionId: z.string(),
  exportType: z.enum(['collection', 'database']).default('collection'),
  database: z.string(),
  collection: z.string().optional(),
  query: z.unknown().default({}),
  isPipeline: z.boolean().default(false),
  format: z.enum(['csv', 'json']),
  options: z.object({
    columns: z.array(z.string()).optional(),
    delimiter: z.string().optional(),
    dateFormat: z.string().optional(),
    excludeCollections: z.array(z.string()).optional(),
    includeIndexes: z.boolean().default(true),
    includeMetadata: z.boolean().default(true),
  }).optional().default({}),
  destination: z.string().optional(),
});

export async function exportRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  app.post('/', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateExportBody.parse(req.body);
    const user = req.user as JWTUser;
    // Superadmins have no profileId — resolve it from the connection's profile
    let profileId = user.profileId;
    if (!profileId) {
      const conn = await prisma.connection.findUnique({ where: { id: body.connectionId }, select: { profileId: true } });
      profileId = conn?.profileId ?? null;
    }
    if (!profileId) return reply.code(400).send({ error: 'No profile assigned' });
    const job = await prisma.exportJob.create({
      data: {
        connectionId: body.connectionId,
        profileId,
        exportType: body.exportType,
        database: body.database,
        collection: body.collection ?? null,
        query: (body.query ?? {}) as object,
        isPipeline: body.isPipeline,
        format: body.format,
        options: (body.options ?? {}) as object,
        destination: body.destination,
      },
    });
    await exportQueue.add('export', { jobId: job.id });
    return reply.code(201).send(job);
  });

  app.get('/', opts, async (req) => {
    const { connectionId } = req.query as { connectionId?: string };
    const scope = profileScope(req);
    return prisma.exportJob.findMany({
      where: { ...(connectionId ? { connectionId } : {}), ...scope },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.get('/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const job = await prisma.exportJob.findFirst({ where: { id: jobId, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return job;
  });

  app.get('/:jobId/download', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const job = await prisma.exportJob.findFirst({ where: { id: jobId, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    if (job.status !== 'done' || !job.fileKey) {
      return reply.code(400).send({ error: 'Export not ready' });
    }
    const filePath = job.fileKey;
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'File not found' });
    }
    const fileName = path.basename(filePath);
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    // Database exports are always zips; single-collection uses format directly
    const contentType = job.exportType === 'database'
      ? 'application/gzip'
      : (job.format === 'csv' ? 'text/csv' : 'application/json');
    reply.header('Content-Type', contentType);
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete('/:jobId', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const job = await prisma.exportJob.findFirst({ where: { id: jobId, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    await prisma.exportJob.delete({ where: { id: jobId } });
    return reply.code(204).send();
  });
}
