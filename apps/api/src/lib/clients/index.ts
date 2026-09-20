import type { DbClient, DbType } from './types.js';
import { MongoDbClient } from './mongo.client.js';
import { PostgresDbClient } from './postgres.client.js';
import { MySqlDbClient } from './mysql.client.js';

export { MongoDbClient, PostgresDbClient, MySqlDbClient };
export type { DbClient, DbType, ProbeResult, DiscoveredNamespace, DiscoveredColumn, RowPage } from './types.js';

/**
 * Build a fresh, single-use client for the given dbType + URI.
 * Caller is responsible for calling `.close()` (use try/finally).
 */
export function makeClient(dbType: DbType, uri: string): DbClient {
  switch (dbType) {
    case 'mongodb':  return new MongoDbClient(uri);
    case 'postgres': return new PostgresDbClient(uri);
    case 'mysql':    return new MySqlDbClient(uri);
    default: {
      const _exhaustive: never = dbType;
      throw new Error(`Unsupported dbType: ${String(_exhaustive)}`);
    }
  }
}
