import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../crypto/encrypt.js';
import { closeMongoClient } from '../lib/mongo.js';
import { makeClient, type DbType } from '../lib/clients/index.js';
import { isValidDbType, validateUri } from '../lib/uri-validators.js';

/** Public shape returned to the API/frontend (URI is NEVER exposed). */
export interface ConnectionPublic {
  id: string;
  name: string;
  dbType: DbType;
  topology: string;
  dbVersion: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[];
  readOnly: boolean;
  createdBy: string;
  profileId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** DB row shape (what Prisma returns from `connection.findFirst` etc.) */
type ConnectionRow = {
  id: string;
  name: string;
  dbType: string;
  topology: string;
  dbVersion: string | null;
  metadata: unknown;
  tags: string[];
  readOnly: boolean;
  createdBy: string;
  profileId: string;
  createdAt: Date;
  updatedAt: Date;
};

export function sanitizeConnection(conn: ConnectionRow): ConnectionPublic {
  return {
    id: conn.id,
    name: conn.name,
    dbType: (isValidDbType(conn.dbType) ? conn.dbType : 'mongodb'),
    topology: conn.topology,
    dbVersion: conn.dbVersion,
    metadata: (conn.metadata && typeof conn.metadata === 'object')
      ? (conn.metadata as Record<string, unknown>)
      : null,
    tags: conn.tags,
    readOnly: conn.readOnly,
    createdBy: conn.createdBy,
    profileId: conn.profileId,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

/**
 * Probe a fresh URI against the chosen engine.
 * Returns metadata used to populate Connection rows on create/test.
 *
 * Throws if URI is malformed for the chosen dbType, or if the probe fails.
 */
export async function probeConnection(dbType: DbType, uri: string) {
  const validationError = validateUri(dbType, uri);
  if (validationError) throw new Error(validationError);

  const client = makeClient(dbType, uri);
  try {
    return await client.probe();
  } finally {
    await client.close();
  }
}

/**
 * Legacy alias retained so existing call sites that still import
 * `detectTopology` keep compiling. New code should call `probeConnection`.
 *
 * @deprecated Use probeConnection(dbType, uri) instead.
 */
export async function detectTopology(uri: string) {
  const probe = await probeConnection('mongodb', uri);
  return { topology: probe.topology, version: probe.version, latencyMs: probe.latencyMs };
}

export async function createConnection(data: {
  name: string;
  dbType: DbType;
  uri: string;
  tags: string[];
  readOnly: boolean;
  createdBy: string;
  profileId: string;
}): Promise<ConnectionPublic> {
  const probe = await probeConnection(data.dbType, data.uri);
  const conn = await prisma.connection.create({
    data: {
      name: data.name,
      encryptedUri: encrypt(data.uri),
      dbType: data.dbType,
      topology: probe.topology,
      dbVersion: probe.version,
      // Prisma's Json input type requires JsonValue, not Record<string, unknown>.
      // probe.metadata is opaque per-engine JSON — cast via unknown is safe.
      metadata: (probe.metadata as unknown) ?? undefined,
      tags: data.tags,
      readOnly: data.readOnly,
      createdBy: data.createdBy,
      profileId: data.profileId,
    },
  });
  return sanitizeConnection(conn);
}

export async function listConnections(scope: Record<string, unknown> = {}): Promise<ConnectionPublic[]> {
  const conns = await prisma.connection.findMany({ where: scope, orderBy: { createdAt: 'desc' } });
  return conns.map(sanitizeConnection);
}

export async function getConnection(id: string, scope: Record<string, unknown> = {}): Promise<ConnectionPublic | null> {
  const conn = await prisma.connection.findFirst({ where: { id, ...scope } });
  return conn ? sanitizeConnection(conn) : null;
}

export async function updateConnection(id: string, data: {
  name?: string; tags?: string[]; readOnly?: boolean;
}, scope: Record<string, unknown> = {}): Promise<ConnectionPublic> {
  const existing = await prisma.connection.findFirst({ where: { id, ...scope } });
  if (!existing) throw new Error('Not found');
  const conn = await prisma.connection.update({ where: { id }, data });
  return sanitizeConnection(conn);
}

export async function deleteConnection(id: string, actor: string, scope: Record<string, unknown> = {}): Promise<void> {
  const existing = await prisma.connection.findFirst({ where: { id, ...scope } });
  if (!existing) throw new Error('Not found');
  await prisma.$transaction(async (tx) => {
    // Pause any continuous CDC syncs that reference this connection, so the
    // worker stops trying to read/write to the now-deleted endpoint.
    await tx.cdcSyncJob.updateMany({
      where: { OR: [{ sourceConnId: id }, { destConnId: id }] },
      data: { enabled: false, pauseRequested: true },
    });
    await tx.backupJob.updateMany({ where: { connectionId: id }, data: { status: 'paused' } });
    await tx.auditEvent.create({
      data: { actor, action: 'delete_connection', target: `connection:${id}` },
    });
    await tx.connection.delete({ where: { id } });
  });
  // Mongo-pool cleanup is a no-op for SQL connections; safe to always call.
  await closeMongoClient(id).catch(() => {});
}

/**
 * Re-probe an existing connection and update cached `dbVersion`/`metadata`.
 * Used by the "Test" button on each connection card.
 */
export async function testConnection(id: string): Promise<{ latencyMs: number; serverVersion: string; topology: string; dbType: DbType }> {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id } });
  const uri = decrypt(conn.encryptedUri);
  const dbType: DbType = isValidDbType(conn.dbType) ? conn.dbType : 'mongodb';
  const probe = await probeConnection(dbType, uri);

  // Refresh cached metadata so the UI shows current values.
  await prisma.connection.update({
    where: { id },
    data: {
      dbVersion: probe.version,
      topology: probe.topology,
      // Prisma's Json input type requires JsonValue, not Record<string, unknown>.
      // probe.metadata is opaque per-engine JSON — cast via unknown is safe.
      metadata: (probe.metadata as unknown) ?? undefined,
    },
  });

  return {
    latencyMs: probe.latencyMs,
    serverVersion: probe.version,
    topology: probe.topology,
    dbType,
  };
}

export async function getDecryptedUri(id: string): Promise<string> {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id } });
  return decrypt(conn.encryptedUri);
}

/** Look up the dbType of a connection without exposing the URI. */
export async function getDbType(id: string): Promise<DbType> {
  const conn = await prisma.connection.findUniqueOrThrow({
    where: { id }, select: { dbType: true },
  });
  return isValidDbType(conn.dbType) ? conn.dbType : 'mongodb';
}
