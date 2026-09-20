import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMongoClient } from '../lib/mongo.js';
import { getDecryptedUri } from '../services/connection.service.js';
import { sampleSchema } from '../services/schema.service.js';
import { prisma } from '../lib/prisma.js';

async function getClient(connectionId: string) {
  const uri = await getDecryptedUri(connectionId);
  return getMongoClient(connectionId, uri);
}

export async function exploreRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // List databases
  app.get('/:id/explore/databases', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const client = await getClient(id);
      const dbs = await client.db().admin().listDatabases();
      return dbs.databases.map((db) => ({ name: db.name, sizeOnDisk: db.sizeOnDisk }));
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // List collections
  app.get('/:id/explore/databases/:db/collections', opts, async (req, reply) => {
    const { id, db } = req.params as { id: string; db: string };
    try {
      const client = await getClient(id);
      const colls = await client.db(db).listCollections().toArray();
      return colls.map((c) => ({ name: c.name, type: c.type }));
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // Sample schema
  app.post('/:id/explore/databases/:db/collections/:coll/schema', opts, async (req, reply) => {
    const { id, db, coll } = req.params as { id: string; db: string; coll: string };
    const { sampleSize = 1000 } = (req.body as { sampleSize?: number }) ?? {};
    try {
      const client = await getClient(id);
      return await sampleSchema(client.db(db), coll, sampleSize);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // Query
  app.post('/:id/explore/databases/:db/collections/:coll/query', opts, async (req, reply) => {
    const { id, db, coll } = req.params as { id: string; db: string; coll: string };
    const body = z.object({
      filter: z.record(z.unknown()).default({}),
      sort: z.record(z.unknown()).optional(),
      limit: z.number().int().min(1).max(1000).default(50),
      skip: z.number().int().min(0).default(0),
      projection: z.record(z.unknown()).optional(),
    }).parse(req.body);
    try {
      const client = await getClient(id);
      let cursor = client.db(db).collection(coll).find(body.filter, { projection: body.projection });
      if (body.sort) cursor = cursor.sort(body.sort as Parameters<typeof cursor.sort>[0]);
      cursor = cursor.skip(body.skip).limit(body.limit);
      const docs = await cursor.toArray();
      const total = await client.db(db).collection(coll).countDocuments(body.filter);
      return { docs, total };
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // Aggregate
  app.post('/:id/explore/databases/:db/collections/:coll/aggregate', opts, async (req, reply) => {
    const { id, db, coll } = req.params as { id: string; db: string; coll: string };
    const body = z.object({
      pipeline: z.array(z.record(z.unknown())),
      limit: z.number().int().min(1).max(10000).default(1000),
    }).parse(req.body);
    try {
      const client = await getClient(id);
      const results = await client.db(db).collection(coll)
        .aggregate([...body.pipeline, { $limit: body.limit }]).toArray();
      return { results };
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // Collection stats
  app.get('/:id/explore/databases/:db/collections/:coll/stats', opts, async (req, reply) => {
    const { id, db, coll } = req.params as { id: string; db: string; coll: string };
    try {
      const client = await getClient(id);
      const stats = await client.db(db).command({ collStats: coll });
      return {
        count: stats.count,
        size: stats.size,
        avgObjSize: stats.avgObjSize,
        storageSize: stats.storageSize,
        totalIndexSize: stats.totalIndexSize,
        nindexes: stats.nindexes,
      };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // List indexes
  app.get('/:id/explore/databases/:db/collections/:coll/indexes', opts, async (req, reply) => {
    const { id, db, coll } = req.params as { id: string; db: string; coll: string };
    try {
      const client = await getClient(id);
      const indexes = await client.db(db).collection(coll).listIndexes().toArray();
      return indexes;
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // Saved queries
  app.get('/:id/explore/saved-queries', opts, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.savedQuery.findMany({ where: { connectionId: id }, orderBy: { createdAt: 'desc' } });
  });

  app.post('/:id/explore/saved-queries', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().min(1),
      database: z.string(),
      collection: z.string(),
      query: z.unknown(),
      isPipeline: z.boolean().default(false),
    }).parse(req.body);
    const user = req.user as { userId: string; email: string; role: string; profileId: string | null };
    const profileId = user.profileId;
    if (!profileId) return reply.code(400).send({ error: 'No profile assigned' });
    const saved = await prisma.savedQuery.create({
      data: { connectionId: id, profileId, ...body, query: body.query as object },
    });
    return reply.code(201).send(saved);
  });

  app.delete('/:id/explore/saved-queries/:queryId', opts, async (req, reply) => {
    const { queryId } = req.params as { id: string; queryId: string };
    await prisma.savedQuery.delete({ where: { id: queryId } });
    return reply.code(204).send();
  });
}
