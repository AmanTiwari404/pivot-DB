/**
 * CLI test runner for Postgres → MongoDB migration.
 *
 * Usage:
 *
 *   pnpm tsx scripts/migrate-pg-to-mongo.ts \
 *     --pg-id      <connection-id>          \
 *     --mongo-id   <connection-id>          \
 *     [--schema     public]                 \
 *     [--mongo-db   <override db name>]     \
 *     [--batch-size 1000]                   \
 *     [--drop]                              \
 *     [--dry-run]
 *
 * --schema picks which PG schema (default public) is the source.
 * --mongo-db, if given, sends every collection into one Mongo database
 *   regardless of source schema. Without it we use `ns.database` (== schema).
 */

import { argv, exit } from 'node:process';
import { decrypt } from '../src/crypto/encrypt.js';
import { prisma } from '../src/lib/prisma.js';
import { PostgresReader } from '../src/migration/readers/postgres.reader.js';
import { MongoWriter } from '../src/migration/writers/mongo.writer.js';
import { PostgresToMongoMapper } from '../src/migration/mappers/pg-to-mongo.mapper.js';
import { runMigration } from '../src/migration/pipeline.js';
import type { MigrationProgress } from '../src/migration/types.js';

interface Args {
  pgId: string;
  mongoId: string;
  schema: string;
  mongoDb?: string;
  batchSize: number;
  drop: boolean;
  dryRun: boolean;
}

const USAGE = `
Migrate Postgres → MongoDB via the Phase 1B pipeline.

Required:
  --pg-id     <id>   Connection row id for the Postgres source
  --mongo-id  <id>   Connection row id for the MongoDB destination

Optional:
  --schema     <s>   Source Postgres schema (default "public")
  --mongo-db   <db>  Destination Mongo database name (default = source schema)
  --batch-size <n>   Docs per insertMany batch (default 1000)
  --drop             Drop destination collection before insert
  --dry-run          Skip writes; only run inference + warnings
`.trim();

function parseArgs(): Args {
  const out: Partial<Args> = {
    schema: 'public',
    batchSize: 1000,
    drop: false,
    dryRun: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    switch (k) {
      case '--pg-id':       out.pgId = v; i++; break;
      case '--mongo-id':    out.mongoId = v; i++; break;
      case '--schema':      out.schema = v; i++; break;
      case '--mongo-db':    out.mongoDb = v; i++; break;
      case '--batch-size':  out.batchSize = Number(v); i++; break;
      case '--drop':        out.drop = true; break;
      case '--dry-run':     out.dryRun = true; break;
      case '--help':
      case '-h':
        console.log(USAGE);
        exit(0);
    }
  }
  if (!out.pgId || !out.mongoId) {
    console.error('Missing required args. Run with --help.');
    exit(1);
  }
  return out as Args;
}

async function main() {
  const args = parseArgs();

  const [pgConn, mongoConn] = await Promise.all([
    prisma.connection.findUniqueOrThrow({ where: { id: args.pgId } }),
    prisma.connection.findUniqueOrThrow({ where: { id: args.mongoId } }),
  ]);

  if (pgConn.dbType !== 'postgres') {
    throw new Error(`--pg-id points at a ${pgConn.dbType} connection. Aborting.`);
  }
  if (mongoConn.dbType !== 'mongodb') {
    throw new Error(`--mongo-id points at a ${mongoConn.dbType} connection. Aborting.`);
  }

  const pgUri    = decrypt(pgConn.encryptedUri);
  const mongoUri = decrypt(mongoConn.encryptedUri);

  console.log(`▶ PG    source: ${pgConn.name} → schema "${args.schema}"`);
  console.log(`▶ Mongo dest:   ${mongoConn.name} → db "${args.mongoDb ?? args.schema}"`);
  console.log(`▶ batch=${args.batchSize}  drop=${args.drop}  dryRun=${args.dryRun}`);
  console.log('');

  const reader = new PostgresReader(pgUri, { schemaName: args.schema });
  const writer = new MongoWriter(mongoUri, {
    dropExisting: args.drop,
    databaseOverride: args.mongoDb,
  });

  const lastTick = new Map<string, number>();
  const onProgress = (p: MigrationProgress) => {
    const key = `${p.namespace.database}.${p.namespace.name}`;
    const total = p.approxTotal ? `/${p.approxTotal}` : '';
    const tick = p.phase + '|' + Math.floor(p.written / 5000);
    const tickN = hash(tick);
    if (lastTick.get(key) === tickN) return;
    lastTick.set(key, tickN);
    console.log(`  [${p.phase.padEnd(12)}] ${key}  ${p.written}${total} written` +
      (p.skipped ? `, ${p.skipped} skipped` : '') +
      (p.failed ? `, ${p.failed} failed` : '') +
      (p.error ? `  ✕ ${p.error}` : ''));
  };

  const start = Date.now();
  const summary = await runMigration(
    reader, writer,
    (schema) => new PostgresToMongoMapper(schema),
    {
      database: args.schema,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
      onProgress,
      onWarning: (w) =>
        console.warn(
          `  ! [${w.severity}] ${w.code} ${w.namespace.name}.${w.column ?? ''} — ${w.message}`,
        ),
    },
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log('───────────────────────────────────────────────');
  console.log(` Done in ${elapsed}s`);
  console.log(`  namespaces:  ${summary.namespaces}`);
  console.log(`  succeeded:   ${summary.succeeded}`);
  console.log(`  failed:      ${summary.failed}`);
  console.log(`  written:     ${summary.totalWritten}`);
  console.log(`  skipped:     ${summary.totalSkipped}`);
  console.log(`  rejected:    ${summary.totalFailed}`);
  console.log(`  warnings:    ${summary.warnings.length}`);
  if (summary.errors.length > 0) {
    console.log('');
    console.log(' Errors:');
    for (const e of summary.errors) {
      console.log(`  - ${e.namespace.database}.${e.namespace.name}: ${e.error}`);
    }
  }
  console.log('───────────────────────────────────────────────');

  await prisma.$disconnect();
  exit(summary.failed > 0 ? 1 : 0);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

main().catch((err) => {
  console.error('Migration failed:', err);
  prisma.$disconnect().finally(() => exit(1));
});
