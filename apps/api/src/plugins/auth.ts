import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fjwt from '@fastify/jwt';

interface JWTUser {
  userId: string;
  email: string;
  role: 'superadmin' | 'admin' | 'viewer';
  profileId: string | null;
}

export default fp(async function authPlugin(app: FastifyInstance) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set (generate: openssl rand -hex 32)');
  }

  await app.register(fjwt, { secret });

  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });
});

export function profileScope(req: FastifyRequest) {
  const user = req.user as JWTUser;
  if (user.role === 'superadmin') return {};
  if (!user.profileId) throw new Error('No profile assigned');
  return { profileId: user.profileId };
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const user = req.user as JWTUser;
  if (user.role === 'viewer') {
    reply.code(403).send({ error: 'Viewers cannot perform this action' });
    return false;
  }
  return true;
}

export function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const user = req.user as JWTUser;
  if (user.role !== 'superadmin') {
    reply.code(403).send({ error: 'Super admin access required' });
    return false;
  }
  return true;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
