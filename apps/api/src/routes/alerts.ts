import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { profileScope, requireAdmin } from '../plugins/auth.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const SUPPORTED_METRICS = [
  'currentConnections', 'availableConnections',
  'memResident', 'memVirtual',
  'opsPerSecTotal', 'replicationLag', 'wtCachePercent',
  'networkBytesIn', 'networkBytesOut',
] as const;

const CreateRuleBody = z.object({
  name: z.string().min(1),
  connectionId: z.string().min(1),
  metric: z.enum(SUPPORTED_METRICS),
  condition: z.enum(['gt', 'lt', 'gte', 'lte']),
  threshold: z.number().positive(),
  durationMinutes: z.number().int().positive().default(1),
  notifyEmail: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  notifyWebhook: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  enabled: z.boolean().default(true),
});

const PatchRuleBody = z.object({
  name: z.string().min(1).optional(),
  threshold: z.number().positive().optional(),
  condition: z.enum(['gt', 'lt', 'gte', 'lte']).optional(),
  durationMinutes: z.number().int().positive().optional(),
  notifyEmail: z.string().optional().nullable(),
  notifyWebhook: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
});

export async function alertRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // ── List rules (optionally filtered by connection) ──────────────────────
  app.get('/rules', opts, async (req) => {
    const scope = profileScope(req);
    const { connectionId } = req.query as { connectionId?: string };
    const where = connectionId ? { ...scope, connectionId } : scope;

    const rules = await prisma.alertRule.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    if (rules.length === 0) return [];

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ruleIds = rules.map((r) => r.id);

    const [latestEventsRaw, eventCounts] = await Promise.all([
      prisma.alertEvent.findMany({
        where: { ruleId: { in: ruleIds } },
        orderBy: { firedAt: 'desc' },
        take: ruleIds.length * 5, // generous; we'll dedupe below
      }),
      prisma.alertEvent.groupBy({
        by: ['ruleId'],
        where: { ruleId: { in: ruleIds }, firedAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
    ]);

    const latestByRule = new Map<string, typeof latestEventsRaw[0]>();
    for (const ev of latestEventsRaw) {
      if (!latestByRule.has(ev.ruleId)) latestByRule.set(ev.ruleId, ev);
    }
    const countByRule = new Map(eventCounts.map((c) => [c.ruleId, c._count._all]));

    return rules.map((r) => ({
      ...r,
      latestEvent: latestByRule.get(r.id) ?? null,
      eventCount: countByRule.get(r.id) ?? 0,
    }));
  });

  // ── Create rule ──────────────────────────────────────────────────────────
  app.post('/rules', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateRuleBody.parse(req.body);
    const user = req.user as JWTUser;

    // Resolve profileId — for superadmin, take it from the connection
    let profileId = user.profileId;
    const conn = await prisma.connection.findUnique({
      where: { id: body.connectionId }, select: { profileId: true },
    });
    if (!conn) return reply.code(404).send({ error: 'Connection not found' });
    if (!profileId) profileId = conn.profileId;
    if (user.role !== 'superadmin' && conn.profileId !== user.profileId) {
      return reply.code(403).send({ error: 'Connection not in your profile' });
    }

    const rule = await prisma.alertRule.create({
      data: {
        name: body.name,
        profileId: profileId!,
        connectionId: body.connectionId,
        metric: body.metric,
        condition: body.condition,
        threshold: body.threshold,
        durationMinutes: body.durationMinutes,
        notifyEmail: body.notifyEmail ?? null,
        notifyWebhook: body.notifyWebhook ?? null,
        enabled: body.enabled,
        status: 'ok',
      },
    });
    return reply.code(201).send(rule);
  });

  // ── Update rule ──────────────────────────────────────────────────────────
  app.patch('/rules/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = PatchRuleBody.parse(req.body);
    const scope = profileScope(req);

    const existing = await prisma.alertRule.findFirst({ where: { id, ...scope } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const data: Record<string, unknown> = { ...body };
    // Coerce empty strings to null for nullable text fields
    if (body.notifyEmail   === '') data.notifyEmail   = null;
    if (body.notifyWebhook === '') data.notifyWebhook = null;

    // If toggling enabled off → mark paused so the evaluator skips it;
    // toggling back on → reset state so the next snapshot re-evaluates.
    if (body.enabled !== undefined) {
      if (body.enabled === false) {
        data.status = 'paused';
        data.firingStartedAt = null;
      } else if (body.enabled === true && existing.enabled === false) {
        data.status = 'ok';
        data.firingStartedAt = null;
        data.lastNotifiedAt = null;
      }
    }

    return prisma.alertRule.update({ where: { id }, data });
  });

  // ── Delete rule (cascades events) ────────────────────────────────────────
  app.delete('/rules/:id', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const scope = profileScope(req);
    const existing = await prisma.alertRule.findFirst({ where: { id, ...scope } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    await prisma.alertRule.delete({ where: { id } });
    return reply.code(204).send();
  });

  // ── Events feed ──────────────────────────────────────────────────────────
  app.get('/events', opts, async (req) => {
    const scope = profileScope(req);
    const { connectionId, status, limit = 50 } = req.query as {
      connectionId?: string; status?: string; limit?: number;
    };
    const where: Record<string, unknown> = { ...scope };
    if (connectionId) where['connectionId'] = connectionId;
    if (status)       where['status'] = status;

    return prisma.alertEvent.findMany({
      where,
      orderBy: { firedAt: 'desc' },
      take: Math.min(Number(limit) || 50, 200),
      include: { rule: { select: { id: true, name: true, metric: true } } },
    });
  });

  // ── Acknowledge a firing event ───────────────────────────────────────────
  app.post('/events/:id/acknowledge', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { note } = (req.body as { note?: string }) ?? {};
    const user = req.user as JWTUser;
    const scope = profileScope(req);

    const event = await prisma.alertEvent.findFirst({ where: { id, ...scope } });
    if (!event) return reply.code(404).send({ error: 'Not found' });
    if (event.status !== 'firing') {
      return reply.code(400).send({ error: `Cannot acknowledge a ${event.status} event` });
    }

    return prisma.alertEvent.update({
      where: { id },
      data: {
        status: 'acknowledged',
        acknowledgedAt: new Date(),
        acknowledgedBy: user.userId,
        note: note ?? null,
      },
    });
  });

  // ── Currently-firing rules across all connections in the profile ────────
  app.get('/active', opts, async (req) => {
    const scope = profileScope(req);
    const rules = await prisma.alertRule.findMany({
      where: { ...scope, status: 'firing', enabled: true },
      include: { connection: { select: { id: true, name: true } } },
    });
    return { count: rules.length, rules };
  });
}
