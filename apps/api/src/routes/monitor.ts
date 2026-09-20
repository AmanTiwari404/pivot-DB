import { FastifyInstance } from 'fastify';
import {
  getSnapshot, getReplicaSetStatus, getCurrentOps, killOp,
  getSlowQueries, enableProfiling, getDatabaseSizes, getCollectionSizes,
} from '../services/monitor.service.js';
import { metricsService } from '../services/metrics.service.js';
import { prisma } from '../lib/prisma.js';
import { evaluateAlerts } from '../lib/alertEvaluator.js';

export async function monitorRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // ── snapshot (used by frontend live view AND prom collector) ──────────────
  app.get('/:id/monitor/snapshot', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const snapshot = await getSnapshot(id);
      // keep Prometheus gauges fresh for the actively-viewed connection
      let profileId: string | null = null;
      try {
        const conn = await prisma.connection.findUnique({
          where: { id }, select: { name: true, profileId: true },
        });
        if (conn) {
          metricsService.updateFromSnapshot(id, conn.name, snapshot);
          profileId = conn.profileId;
        }
      } catch { /* gauges are best-effort */ }

      // Fire-and-forget: evaluate alerts. Never blocks the response, never throws.
      if (profileId) {
        evaluateAlerts(id, profileId, snapshot).catch((err: Error) =>
          console.error('[AlertEvaluator]', err.message),
        );
      }
      return snapshot;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── replica set raw status (debugging) ────────────────────────────────────
  app.get('/:id/monitor/replicaset', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getReplicaSetStatus(id);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── current ops ───────────────────────────────────────────────────────────
  app.get('/:id/monitor/currentops', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getCurrentOps(id);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── kill op (POST per PRD; DELETE kept for back-compat) ───────────────────
  const killHandler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const params = req.params as { id: string; opid?: string };
    const body = (req.body as { opid?: string | number; confirmed?: boolean }) ?? {};
    const opid = params.opid ?? body.opid;
    if (opid === undefined || opid === null) {
      return reply.code(400).send({ error: 'opid is required' });
    }
    const user = req.user as { email: string };
    try {
      return await killOp(params.id, opid, user.email);
    } catch (err) {
      const e = err as Error & { code?: number };
      return reply.code(e.code === 403 ? 403 : 500).send({ error: e.message });
    }
  };
  app.post('/:id/monitor/killop', opts, killHandler);
  app.delete('/:id/monitor/currentops/:opid', opts, killHandler);

  // ── slow queries ──────────────────────────────────────────────────────────
  app.get('/:id/monitor/slowqueries', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { thresholdMs = 100 } = req.query as { thresholdMs?: number };
    try {
      return await getSlowQueries(id, Number(thresholdMs));
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── enable profiling on a database ────────────────────────────────────────
  app.post('/:id/monitor/profiling', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { db, slowMs = 100 } = (req.body as { db: string; slowMs?: number }) ?? {};
    if (!db) return reply.code(400).send({ error: 'db is required' });
    try {
      return await enableProfiling(id, db, Number(slowMs));
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── database sizes ────────────────────────────────────────────────────────
  app.get('/:id/monitor/dbsizes', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getDatabaseSizes(id);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
  // back-compat path
  app.get('/:id/monitor/databases/sizes', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getDatabaseSizes(id);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── collection sizes for a database ───────────────────────────────────────
  app.get('/:id/monitor/collsizes', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { db } = req.query as { db?: string };
    if (!db) return reply.code(400).send({ error: 'db query param is required' });
    try {
      return await getCollectionSizes(id, db);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}

export function registerMonitorSocket(app: FastifyInstance) {
  const io = app.io;
  const ns = io.of(/^\/monitor\/.+$/);

  ns.on('connection', async (socket) => {
    const connectionId = socket.nsp.name.replace('/monitor/', '');
    let interval: ReturnType<typeof setInterval> | undefined;

    try {
      interval = setInterval(async () => {
        try {
          const ops = await getCurrentOps(connectionId);
          socket.emit('currentops', ops);
        } catch { /* connection may be unavailable */ }
      }, 3000);

      socket.on('disconnect', () => {
        if (interval) clearInterval(interval);
      });
    } catch (err) {
      socket.emit('error', String(err));
    }
  });
}
