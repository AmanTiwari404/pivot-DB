import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createConnection, listConnections, getConnection,
  updateConnection, deleteConnection, testConnection,
} from '../services/connection.service.js';
import { profileScope, requireAdmin, requireSuperAdmin } from '../plugins/auth.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword, PasswordSchema } from '../lib/password.js';

const CreateBody = z.object({
  name: z.string().min(1),
  // dbType defaults to mongodb so existing clients (no field sent) still work.
  dbType: z.enum(['mongodb', 'postgres', 'mysql']).default('mongodb'),
  uri: z.string().min(1),
  tags: z.array(z.string()).default([]),
  readOnly: z.boolean().default(false),
});

const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  readOnly: z.boolean().optional(),
});

interface JWTUser {
  userId: string;
  email: string;
  role: 'superadmin' | 'admin' | 'viewer';
  profileId: string | null;
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RegisterBody = z.object({
  email: z.string().email(),
  password: PasswordSchema,
});

const CreateProfileBody = z.object({
  name: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: PasswordSchema,
});

const InviteViewerBody = z.object({
  email: z.string().email(),
  password: PasswordSchema,
});

export async function connectionRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const scope = profileScope(req);
    return listConnections(scope);
  });

  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateBody.parse(req.body);
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(400).send({ error: 'No profile assigned' });
    try {
      const conn = await createConnection({ ...body, createdBy: user.email, profileId: user.profileId });
      return reply.code(201).send(conn);
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);
    const conn = await getConnection(id, scope);
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    return conn;
  });

  app.put('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = UpdateBody.parse(req.body);
    const scope = profileScope(req);
    try {
      return await updateConnection(id, body, scope);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    const scope = profileScope(req);
    try {
      await deleteConnection(id, user.email, scope);
      return reply.code(204).send();
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.post('/:id/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await testConnection(id);
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // ── Schema discovery (Phase 0 of cross-engine migration) ───────────────────
  // Returns a uniform shape across mongodb / postgres / mysql so the Migrate
  // wizard can render the same tree component for any source.
  app.get('/:id/schema', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { database, sampleSize } = req.query as { database?: string; sampleSize?: string };
    const scope = profileScope(req);

    const conn = await prisma.connection.findFirst({ where: { id, ...scope } });
    if (!conn) return reply.code(404).send({ error: 'Not found' });

    try {
      const { discoverConnectionSchema } = await import('../services/discovery.service.js');
      const namespaces = await discoverConnectionSchema(id, {
        database,
        sampleSize: sampleSize ? Number(sampleSize) : undefined,
      });
      return { dbType: conn.dbType, namespaces };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // List databases visible to this connection's credential.
  // Used by the Migrate wizard's "pick a database" step.
  app.get('/:id/databases', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);
    const conn = await prisma.connection.findFirst({ where: { id, ...scope } });
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    try {
      const { listConnectionDatabases } = await import('../services/discovery.service.js');
      const databases = await listConnectionDatabases(id);
      return { dbType: conn.dbType, databases };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ── SQL rows fetch (Phase 2A) ──────────────────────────────────────────────
  // Used by the SqlExplorer on the Explore page. Refuses Mongo connections
  // because Mongo has its own `/explore/*` endpoints with richer filtering.
  app.get('/:id/sql/tables/:database/:table/rows', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id, database, table } = req.params as { id: string; database: string; table: string };
    const { limit = '50', offset = '0' } = req.query as { limit?: string; offset?: string };
    const scope = profileScope(req);

    const conn = await prisma.connection.findFirst({ where: { id, ...scope } });
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    if (conn.dbType === 'mongodb') {
      return reply.code(400).send({ error: 'Use /explore endpoints for MongoDB connections' });
    }

    try {
      const { fetchSqlRows } = await import('../services/discovery.service.js');
      return await fetchSqlRows(id, { database, name: table }, {
        limit: Number(limit), offset: Number(offset),
      });
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ── SQL monitor snapshot (Phase 2B) ────────────────────────────────────────
  // Returns the SqlMonitorSnapshot for a Postgres or MySQL connection.
  // Mongo connections must use the existing /monitor/snapshot endpoint.
  app.get('/:id/sql/monitor/snapshot', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);

    const conn = await prisma.connection.findFirst({ where: { id, ...scope } });
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    if (conn.dbType === 'mongodb') {
      return reply.code(400).send({ error: 'Use /monitor/snapshot for MongoDB connections' });
    }

    try {
      const { getSqlMonitorSnapshot } = await import('../services/sql-monitor.service.js');
      return await getSqlMonitorSnapshot(id);
    } catch (err) {
      // AggregateError (DNS / TCP multi-attempt failure) has an empty .message;
      // unwrap the first inner error so the UI shows the real cause.
      let msg: string;
      if (err instanceof AggregateError && err.errors?.length) {
        msg = (err.errors[0] as Error).message ?? String(err.errors[0]);
      } else {
        msg = (err as Error).message ?? String(err);
      }
      return reply.code(500).send({ error: `Cannot connect to ${conn.dbType} server: ${msg}` });
    }
  });

  // ── Auth routes ────────────────────────────────────────────────────────────

  // Whether the instance still needs its first superadmin account created.
  // Drives the frontend's choice between showing the sign-in vs sign-up page.
  app.get('/auth/status', async () => {
    const count = await prisma.user.count();
    return { needsSetup: count === 0 };
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid email or password' });
    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' });
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const payload: JWTUser = {
      userId: user.id,
      email: user.email,
      role: user.role as JWTUser['role'],
      profileId: user.profileId,
    };
    const token = app.jwt.sign(payload, { expiresIn: '7d' });
    return { token, user: { id: user.id, email: user.email, role: user.role, profileId: user.profileId } };
  });

  // Register — only works when 0 users exist (creates the first superadmin).
  // This is the app's one-time setup step; after that, accounts are created
  // via invites (see /profiles and /profiles/:id/viewers below).
  app.post('/auth/register', async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    const { email, password } = parsed.data;
    const count = await prisma.user.count();
    if (count > 0) {
      return reply.code(403).send({ error: 'Setup already complete. Contact your super admin for access.' });
    }
    const passwordHash = await hashPassword(password);
    try {
      const user = await prisma.user.create({
        data: { email, passwordHash, role: 'superadmin' },
      });
      const payload: JWTUser = { userId: user.id, email: user.email, role: 'superadmin', profileId: null };
      const token = app.jwt.sign(payload, { expiresIn: '7d' });
      return reply.code(201).send({ token, user: { id: user.id, email: user.email, role: user.role, profileId: user.profileId } });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });

  // ── Profile management routes (superadmin only) ────────────────────────────

  app.post('/profiles', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const parsed = CreateProfileBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    const { name, adminEmail, adminPassword } = parsed.data;
    const passwordHash = await hashPassword(adminPassword);
    try {
      const adminUser = await prisma.user.create({
        data: { email: adminEmail, passwordHash, role: 'admin' },
      });
      const profile = await prisma.profile.create({
        data: { name, adminId: adminUser.id },
      });
      await prisma.user.update({ where: { id: adminUser.id }, data: { profileId: profile.id } });
      return reply.code(201).send({ profile, adminUser: { id: adminUser.id, email: adminUser.email } });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });

  app.get('/profiles', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    return prisma.profile.findMany({
      include: { users: { select: { id: true, email: true, role: true, createdAt: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.delete('/profiles/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    await prisma.user.deleteMany({ where: { profileId: id } });
    await prisma.profile.delete({ where: { id } });
    return reply.code(204).send();
  });

  // Invite viewer to a profile (admin of that profile or superadmin)
  app.post('/profiles/:id/viewers', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    if (user.role === 'admin' && user.profileId !== id) {
      return reply.code(403).send({ error: 'Can only invite to your own profile' });
    }
    const parsed = InviteViewerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    const { email, password } = parsed.data;
    const passwordHash = await hashPassword(password);
    try {
      const viewer = await prisma.user.create({
        data: { email, passwordHash, role: 'viewer', profileId: id, invitedBy: user.userId },
      });
      return reply.code(201).send({ id: viewer.id, email: viewer.email, role: viewer.role });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });

  app.get('/profiles/:id/viewers', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    if (user.role === 'admin' && user.profileId !== id) {
      return reply.code(403).send({ error: 'Access denied' });
    }
    return prisma.user.findMany({
      where: { profileId: id, role: 'viewer' },
      select: { id: true, email: true, createdAt: true, lastLoginAt: true },
    });
  });

  app.delete('/profiles/:id/viewers/:userId', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, userId } = req.params as { id: string; userId: string };
    const user = req.user as JWTUser;
    if (user.role === 'admin' && user.profileId !== id) {
      return reply.code(403).send({ error: 'Access denied' });
    }
    await prisma.user.delete({ where: { id: userId, profileId: id, role: 'viewer' } });
    return reply.code(204).send();
  });
}
