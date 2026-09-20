import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { isValidDbType } from '../lib/uri-validators.js';
import type { DbType } from '../lib/clients/index.js';
import { MongoReader } from './readers/mongo.reader.js';
import { PostgresReader } from './readers/postgres.reader.js';
import { MySqlReader } from './readers/mysql.reader.js';
import { MongoWriter } from './writers/mongo.writer.js';
import { PostgresWriter } from './writers/postgres.writer.js';
import { MySqlWriter } from './writers/mysql.writer.js';
import { MongoToPostgresMapper } from './mappers/mongo-to-pg.mapper.js';
import { PostgresToMongoMapper } from './mappers/pg-to-mongo.mapper.js';
import { MongoToMysqlMapper } from './mappers/mongo-to-mysql.mapper.js';
import { MysqlToMongoMapper } from './mappers/mysql-to-mongo.mapper.js';
import { PostgresToMysqlMapper } from './mappers/postgres-to-mysql.mapper.js';
import { MysqlToPostgresMapper } from './mappers/mysql-to-postgres.mapper.js';
import { IdentityMapper } from './mappers/identity.mapper.js';
import type { NamespaceReader, NamespaceWriter, RecordMapper, InferredSchema } from './types.js';

/**
 * Build the (reader, writer, mapperFactory) triple appropriate for a job row.
 *
 * Supported directions:
 *   Phase 1: mongodb ↔ postgres
 *   Phase 2: mongodb ↔ mysql
 *   Phase 3: postgres ↔ mysql
 */
export interface MigrationPlan {
  reader: NamespaceReader;
  writer: NamespaceWriter;
  makeMapper: (sourceSchema: InferredSchema) => RecordMapper;
  /** Resolved source database / schema name (already defaulted). */
  sourceDatabase: string;
}

export async function buildMigrationPlan(jobId: string): Promise<MigrationPlan> {
  const job = await prisma.migrationJobV2.findUniqueOrThrow({
    where: { id: jobId },
    include: { source: true, destination: true },
  });

  return buildPlanForPair({
    sourceType:     job.sourceType,
    destType:       job.destType,
    sourceUri:      decrypt(job.source.encryptedUri),
    destUri:        decrypt(job.destination.encryptedUri),
    sourceDatabase: job.sourceDatabase,
    destDatabase:   job.destDatabase,
    dropExisting:   job.dropExisting,
  });
}

/**
 * Engine-pair → (reader, writer, mapper) without needing a MigrationJobV2 row.
 * Used by both the V2 migration worker and the CDC sync worker's bootstrap
 * snapshot phase (Phase 4B+).
 */
export interface PairInputs {
  sourceType: string;
  destType: string;
  sourceUri: string;
  destUri: string;
  sourceDatabase: string | null;
  destDatabase: string | null;
  /** Drop existing destination tables/collections before re-creating. */
  dropExisting: boolean;
}

export function buildPlanForPair(input: PairInputs): MigrationPlan {
  const sourceType = normaliseDbType(input.sourceType);
  const destType   = normaliseDbType(input.destType);
  const { sourceUri, destUri, dropExisting } = input;
  const sourceDbRaw = input.sourceDatabase;
  const destDbRaw   = input.destDatabase;

  const key = `${sourceType}→${destType}`;
  switch (key) {
    case 'mongodb→postgres': {
      const sourceDb = sourceDbRaw ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mongodb → postgres');
      return {
        reader: new MongoReader(sourceUri),
        writer: new PostgresWriter(destUri, {
          schemaName: destDbRaw ?? 'public',
          dropExisting: dropExisting,
        }),
        makeMapper: (schema) => new MongoToPostgresMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'postgres→mongodb': {
      const sourceDb = sourceDbRaw ?? 'public';
      return {
        reader: new PostgresReader(sourceUri, { schemaName: sourceDb }),
        writer: new MongoWriter(destUri, {
          dropExisting: dropExisting,
          databaseOverride: destDbRaw ?? undefined,
        }),
        makeMapper: (schema) => new PostgresToMongoMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mongodb→mysql': {
      const sourceDb = sourceDbRaw ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mongodb → mysql');
      return {
        reader: new MongoReader(sourceUri),
        writer: new MySqlWriter(destUri, {
          dbName: destDbRaw ?? undefined,
          dropExisting: dropExisting,
        }),
        makeMapper: (schema) => new MongoToMysqlMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mysql→mongodb': {
      const sourceDb = sourceDbRaw ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mysql → mongodb');
      return {
        reader: new MySqlReader(sourceUri, { dbName: sourceDb }),
        writer: new MongoWriter(destUri, {
          dropExisting: dropExisting,
          databaseOverride: destDbRaw ?? undefined,
        }),
        makeMapper: (schema) => new MysqlToMongoMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'postgres→mysql': {
      const sourceDb = sourceDbRaw ?? 'public';
      return {
        reader: new PostgresReader(sourceUri, { schemaName: sourceDb }),
        writer: new MySqlWriter(destUri, {
          dbName: destDbRaw ?? undefined,
          dropExisting: dropExisting,
        }),
        makeMapper: (schema) => new PostgresToMysqlMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mysql→postgres': {
      const sourceDb = sourceDbRaw ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mysql → postgres');
      return {
        reader: new MySqlReader(sourceUri, { dbName: sourceDb }),
        writer: new PostgresWriter(destUri, {
          schemaName: destDbRaw ?? 'public',
          dropExisting: dropExisting,
        }),
        makeMapper: (schema) => new MysqlToPostgresMapper(schema),
        sourceDatabase: sourceDb,
      };
    }

    // ─── Same-engine pairs ───────────────────────────────────────────────────
    // The reader and writer are matching engines, so the schema needs no
    // translation — IdentityMapper passes records through unchanged. These
    // pairs are equivalent in scope to the legacy mongodump-based flow but
    // streamed and resumable like the cross-engine ones.

    case 'mongodb→mongodb': {
      const sourceDb = sourceDbRaw ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mongodb → mongodb');
      return {
        reader: new MongoReader(sourceUri),
        writer: new MongoWriter(destUri, {
          dropExisting: dropExisting,
          databaseOverride: destDbRaw ?? undefined,
        }),
        makeMapper: (schema) => new IdentityMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'postgres→postgres': {
      const sourceDb = sourceDbRaw ?? 'public';
      return {
        reader: new PostgresReader(sourceUri, { schemaName: sourceDb }),
        writer: new PostgresWriter(destUri, {
          schemaName: destDbRaw ?? sourceDb,
          dropExisting: dropExisting,
        }),
        makeMapper: (schema) => new IdentityMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mysql→mysql': {
      const sourceDb = sourceDbRaw ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mysql → mysql');
      return {
        reader: new MySqlReader(sourceUri, { dbName: sourceDb }),
        writer: new MySqlWriter(destUri, {
          dbName: destDbRaw ?? sourceDb,
          dropExisting: dropExisting,
        }),
        makeMapper: (schema) => new IdentityMapper(schema),
        sourceDatabase: sourceDb,
      };
    }

    default:
      throw new Error(
        `Migration direction "${key}" is not yet supported. ` +
        `Supported: all 9 pairs across mongodb / postgres / mysql.`,
      );
  }
}

function normaliseDbType(s: string): DbType {
  if (!isValidDbType(s)) throw new Error(`Unknown dbType "${s}"`);
  return s;
}
