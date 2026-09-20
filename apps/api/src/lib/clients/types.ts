/**
 * Common types for the multi-engine database client abstraction.
 *
 * Every supported engine implements `DbClient` so connection probing,
 * schema discovery, and (later) migration readers/writers can be wired
 * up uniformly. See ./mongo.client.ts, ./postgres.client.ts, ./mysql.client.ts.
 */

export type DbType = 'mongodb' | 'postgres' | 'mysql';

/** Result of probing a fresh connection. */
export interface ProbeResult {
  /** Engine version string (e.g. "7.0.5", "16.2", "8.0.36"). */
  version: string;
  /** Round-trip latency in ms for the probe command. */
  latencyMs: number;
  /**
   * Mongo-only topology hint ("standalone" | "replicaSet" | "sharded").
   * SQL engines always return "standalone".
   */
  topology: string;
  /** Free-form per-engine extras surfaced to the UI (e.g. PG schema list). */
  metadata?: Record<string, unknown>;
}

/**
 * Logical schema description returned by discovery.
 * For Mongo: `namespaces` are collections, `columns` is a sampled field set.
 * For SQL : `namespaces` are tables,      `columns` is the declared schema.
 */
export interface DiscoveredNamespace {
  /** Containing database (Mongo) or schema (Postgres "public") or database (MySQL). */
  database: string;
  /** Collection (Mongo) or table (SQL) name. */
  name: string;
  /** Approximate row/doc count, if cheaply available. */
  approxCount?: number;
  /** Discovered columns/fields with inferred or declared types. */
  columns: DiscoveredColumn[];
}

export interface DiscoveredColumn {
  name: string;
  /** Canonical type token (e.g. "string", "int", "decimal", "jsonb", "objectid"). */
  type: string;
  nullable: boolean;
  /** True if this column is part of the primary key / Mongo _id. */
  primaryKey?: boolean;
  /** For SQL FK columns — referenced "schema.table.column". */
  references?: string;
  /** For Mongo: how many sampled docs contained this field. */
  presenceCount?: number;
  /** For Mongo: distinct types observed if mixed. */
  observedTypes?: string[];
}

/**
 * Per-engine driver wrapper. Stateless beyond the URI it owns.
 * Implementations live in {mongo,postgres,mysql}.client.ts.
 */
export interface DbClient {
  readonly dbType: DbType;
  /** Open + close a probe, returning version/latency/topology. */
  probe(): Promise<ProbeResult>;
  /** List databases / schemas visible to this credential. */
  listDatabases(): Promise<string[]>;
  /** Discover all namespaces in the given database (or all dbs if undefined). */
  discoverSchema(database?: string, options?: { sampleSize?: number }): Promise<DiscoveredNamespace[]>;
  /**
   * Fetch a page of rows / docs from a single namespace. Used by Explore.
   * Implementations MUST cap `limit` (server-side safety) and clamp `offset`
   * to a non-negative integer. Returns the rows + a best-effort total count.
   */
  fetchRows(
    namespace: { database: string; name: string },
    opts: { limit: number; offset: number },
  ): Promise<RowPage>;
  /** Release any held resources. Safe to call multiple times. */
  close(): Promise<void>;
}

export interface RowPage {
  rows: Array<Record<string, unknown>>;
  /** Total row/doc count for the namespace. May be approximate for huge tables. */
  total: number;
  /** True if the count is exact; false if it's an estimate. */
  totalExact: boolean;
  /** Column metadata for SQL — matches what discovery returns. Undefined for Mongo. */
  columns?: DiscoveredColumn[];
}
