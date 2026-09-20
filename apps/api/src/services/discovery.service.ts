import { decrypt } from '../crypto/encrypt.js';
import { prisma } from '../lib/prisma.js';
import { makeClient } from '../lib/clients/index.js';
import { isValidDbType } from '../lib/uri-validators.js';
import type { DbType, DiscoveredNamespace, RowPage } from '../lib/clients/index.js';

/**
 * Discovery service — thin wrapper around DbClient implementations.
 *
 * Routes call into here so they don't need to know about driver lifecycles.
 * Every call opens a fresh client + closes it in a `finally` block; we do NOT
 * pool discovery clients (they're rare and might use credentials the long-
 * lived monitor pool shouldn't share).
 */

async function withClient<T>(
  connectionId: string,
  fn: (client: ReturnType<typeof makeClient>, dbType: DbType) => Promise<T>,
): Promise<T> {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const dbType: DbType = isValidDbType(conn.dbType) ? conn.dbType : 'mongodb';
  const uri = decrypt(conn.encryptedUri);
  const client = makeClient(dbType, uri);
  try {
    return await fn(client, dbType);
  } finally {
    await client.close();
  }
}

export async function listConnectionDatabases(connectionId: string): Promise<string[]> {
  return withClient(connectionId, (c) => c.listDatabases());
}

export async function discoverConnectionSchema(
  connectionId: string,
  options: { database?: string; sampleSize?: number } = {},
): Promise<DiscoveredNamespace[]> {
  return withClient(connectionId, (c) => c.discoverSchema(options.database, { sampleSize: options.sampleSize }));
}

/**
 * Fetch a page of rows from a SQL table (Phase 2A — SqlExplorer).
 * Mongo connections should use the existing /explore/* routes instead.
 */
export async function fetchSqlRows(
  connectionId: string,
  ns: { database: string; name: string },
  opts: { limit: number; offset: number },
): Promise<RowPage> {
  return withClient(connectionId, (c) => c.fetchRows(ns, opts));
}
