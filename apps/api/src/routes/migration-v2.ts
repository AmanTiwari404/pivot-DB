import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { migrationV2Queue } from '../lib/queue.js';
import { profileScope, requireAdmin } from '../plugins/auth.js';
import { buildMigrationPlan } from '../migration/service.js';
import { runMigration } from '../migration/pipeline.js';
import { buildCreateTable } from '../migration/ddl/postgres-ddl.js';
import { buildMysqlCreateTable } from '../migration/ddl/mysql-ddl.js';
import type { InferredSchema, SchemaWarning } from '../migration/types.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const CreateJobBody = z.object({
  name: z.string().min(1),
  sourceConnId: z.string(),
  destConnId: z.string(),
  // Mongo db name (source) or PG schema name (source/dest)
  sourceDatabase: z.string().optional(),
  destDatabase: z.string().optional(),
  sampleSize: z.number().int().positive().max(100_000).default(1000),
  batchSize: z.number().int().positive().max(10_000).default(1000),
  parallelism: z.number().int().positive().max(16).default(1),
  dropExisting: z.boolean().default(false),
  failOnTypeConflict: z.boolean().default(false),
  schemaMapping: z.unknown().optional(),
  typeMappingRules: z.unknown().optional(),
});

const PreviewBody = CreateJobBody.extend({
  // Preview uses an ephemeral job — we don't persist a row for it.
  // Re-using the schema keeps the client form payload identical.
});

const RunBody = z.object({
  dryRun: z.boolean().default(false),
});

export async function migrationV2Routes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // ── List jobs in scope ──────────────────────────────────────────────────
  app.get('/jobs', opts, async (req) => {
    const scope = profileScope(req);
    return prisma.migrationJobV2.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      include: {
        source: { select: { id: true, name: true, dbType: true } },
        destination: { select: { id: true, name: true, dbType: true } },
        runs: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
  });

  // ── Create a migration job (no run started yet) ─────────────────────────
  app.post('/jobs', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(400).send({ error: 'No profile assigned' });

    const body = CreateJobBody.parse(req.body);

    // Resolve dbTypes from connections (so worker doesn't need to JOIN).
    const [src, dst] = await Promise.all([
      prisma.connection.findFirstOrThrow({ where: { id: body.sourceConnId, profileId: user.profileId } }),
      prisma.connection.findFirstOrThrow({ where: { id: body.destConnId,   profileId: user.profileId } }),
    ]);

    const job = await prisma.migrationJobV2.create({
      data: {
        name: body.name,
        profileId: user.profileId,
        sourceConnId: body.sourceConnId,
        destConnId:   body.destConnId,
        sourceType:   src.dbType,
        destType:     dst.dbType,
        sourceDatabase: body.sourceDatabase,
        destDatabase:   body.destDatabase,
        sampleSize:   body.sampleSize,
        batchSize:    body.batchSize,
        parallelism:  body.parallelism,
        dropExisting: body.dropExisting,
        failOnTypeConflict: body.failOnTypeConflict,
        schemaMapping:    body.schemaMapping as object | undefined,
        typeMappingRules: body.typeMappingRules as object | undefined,
        createdBy: user.email,
      },
    });

    await prisma.auditEvent.create({
      data: {
        actor: user.email, action: 'create_migration_v2', target: `migration_v2:${job.id}`,
        metadata: { name: body.name, sourceType: src.dbType, destType: dst.dbType },
      },
    });

    return reply.code(201).send(job);
  });

  // ── Preview (dry-run inference, no row stored) ──────────────────────────
  // Returns the inferred schemas + warnings + DDL preview WITHOUT writing.
  // Used by the wizard's "Preview" step.
  app.post('/preview', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(400).send({ error: 'No profile assigned' });

    const body = PreviewBody.parse(req.body);
    const [src, dst] = await Promise.all([
      prisma.connection.findFirstOrThrow({ where: { id: body.sourceConnId, profileId: user.profileId } }),
      prisma.connection.findFirstOrThrow({ where: { id: body.destConnId,   profileId: user.profileId } }),
    ]);

    // Build an ephemeral job-shaped object the planner accepts. We persist
    // a TEMP row + delete it because buildMigrationPlan currently reads from
    // the DB; cheap (~5ms) and keeps the planner free of "is this real?" logic.
    const temp = await prisma.migrationJobV2.create({
      data: {
        name: `__preview__${Date.now()}`,
        profileId: user.profileId,
        sourceConnId: body.sourceConnId,
        destConnId: body.destConnId,
        sourceType: src.dbType, destType: dst.dbType,
        sourceDatabase: body.sourceDatabase, destDatabase: body.destDatabase,
        sampleSize: body.sampleSize, batchSize: body.batchSize, parallelism: 1,
        dropExisting: false,
        createdBy: user.email,
      },
    });

    const schemas: InferredSchema[] = [];
    const warnings: SchemaWarning[] = [];
    try {
      const plan = await buildMigrationPlan(temp.id);
      try {
        await runMigration(plan.reader, plan.writer, (s) => {
          const mapper = plan.makeMapper(s);
          schemas.push(mapper.translateSchema(s));
          return mapper;
        }, {
          database: plan.sourceDatabase,
          sampleSize: body.sampleSize,
          dryRun: true,
          onWarning: (w) => warnings.push(w),
        });
      } finally {
        await plan.reader.close().catch(() => {});
        await plan.writer.close().catch(() => {});
      }
    } finally {
      await prisma.migrationJobV2.delete({ where: { id: temp.id } }).catch(() => {});
    }

    // Generate DDL preview for Mongo→SQL directions. SQL→Mongo has no DDL.
    const ddl: string[] = [];
    if (src.dbType === 'mongodb' && dst.dbType === 'postgres') {
      for (const s of schemas) {
        ddl.push(...buildCreateTable(s, {
          schemaName: body.destDatabase ?? 'public',
          tableName: s.namespace.name,
          ifNotExists: !body.dropExisting,
          drop: body.dropExisting,
        }));
      }
    } else if (src.dbType === 'mongodb' && dst.dbType === 'mysql') {
      for (const s of schemas) {
        ddl.push(...buildMysqlCreateTable(s, {
          dbName: body.destDatabase ?? s.namespace.database,
          tableName: s.namespace.name,
          ifNotExists: !body.dropExisting,
          drop: body.dropExisting,
        }));
      }
    } else if (src.dbType === 'postgres' && dst.dbType === 'mysql') {
      // PG→MySQL: PG schema is already inferred; generate MySQL DDL from it.
      for (const s of schemas) {
        ddl.push(...buildMysqlCreateTable(s, {
          dbName: body.destDatabase ?? s.namespace.database,
          tableName: s.namespace.name,
          ifNotExists: !body.dropExisting,
          drop: body.dropExisting,
        }));
      }
    } else if (src.dbType === 'mysql' && dst.dbType === 'postgres') {
      // MySQL→PG: MySQL schema is already inferred; generate PG DDL from it.
      for (const s of schemas) {
        ddl.push(...buildCreateTable(s, {
          schemaName: body.destDatabase ?? 'public',
          tableName: s.namespace.name,
          ifNotExists: !body.dropExisting,
          drop: body.dropExisting,
        }));
      }
    }

    return { schemas, warnings, ddl };
  });

  // ── Start (or re-run) a job ─────────────────────────────────────────────
  app.post('/jobs/:id/run', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const user = req.user as JWTUser;
    const { id } = req.params as { id: string };
    const body = RunBody.parse(req.body ?? {});
    const scope = profileScope(req);

    const job = await prisma.migrationJobV2.findFirst({ where: { id, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    const run = await prisma.migrationRunV2.create({
      data: {
        jobId: id,
        profileId: job.profileId,
        dryRun: body.dryRun,
      },
    });

    await migrationV2Queue.add('run', { runId: run.id }, {
      // Each run gets a stable jobId so duplicate enqueues are coalesced.
      jobId: `migration-v2-run-${run.id}`,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    });

    await prisma.auditEvent.create({
      data: {
        actor: user.email, action: 'start_migration_v2', target: `migration_v2_run:${run.id}`,
        metadata: { jobId: id, dryRun: body.dryRun },
      },
    });

    return reply.code(202).send({ runId: run.id, status: 'queued' });
  });

  // ── Fetch a run's current state ─────────────────────────────────────────
  app.get('/runs/:id', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    const run = await prisma.migrationRunV2.findUnique({
      where: { id },
      include: { job: true },
    });
    if (!run) return reply.code(404).send({ error: 'Not found' });
    if (user.role !== 'superadmin' && run.profileId !== user.profileId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    return run;
  });

  // ── List runs for a job ─────────────────────────────────────────────────
  app.get('/jobs/:id/runs', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);
    const job = await prisma.migrationJobV2.findFirst({ where: { id, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return prisma.migrationRunV2.findMany({
      where: { jobId: id }, orderBy: { createdAt: 'desc' }, take: 20,
    });
  });

  // ── Request cancellation ────────────────────────────────────────────────
  app.post('/runs/:id/cancel', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    const run = await prisma.migrationRunV2.findUnique({ where: { id } });
    if (!run) return reply.code(404).send({ error: 'Not found' });
    if (user.role !== 'superadmin' && run.profileId !== user.profileId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    if (run.phase === 'succeeded' || run.phase === 'failed' || run.phase === 'cancelled') {
      return reply.code(409).send({ error: `Run already in terminal phase: ${run.phase}` });
    }
    await prisma.migrationRunV2.update({
      where: { id }, data: { cancelRequested: true },
    });
    return { ok: true };
  });

  // ── Delete a job (cascades runs) ────────────────────────────────────────
  app.delete('/jobs/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    const scope = profileScope(req);
    const job = await prisma.migrationJobV2.findFirst({ where: { id, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    await prisma.migrationJobV2.delete({ where: { id } });
    await prisma.auditEvent.create({
      data: { actor: user.email, action: 'delete_migration_v2', target: `migration_v2:${id}` },
    });
    return reply.code(204).send();
  });
}
