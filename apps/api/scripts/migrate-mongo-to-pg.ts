/**
 * CLI test runner for Mongo → Postgres migration.
 *
 * Usage:
 *
 *   pnpm tsx scripts/migrate-mongo-to-pg.ts \
 *     --mongo-id  <connection-id>           \
 *     --pg-id     <connection-id>           \
 *     --database  <source-db-name>          \
 *     [--dest-schema public]                \
 *     [--sample-size 1000]                  \
 *     [--batch-size 1000]                   \
 *     [--drop]                              \
 *     [--dry-run]
 *
 * This exists to prove Phase 1A end-to-end before the BullMQ worker / API
 * layer / wizard UI are built. It reads decrypted URIs straight from the
 * Connection table (the same way the worker will), then drives the pipeline.
 *
 * NOTE: this CLI takes the same Postgres connection users would add via the
 * UI, but the migration code path doesn't *create* a database for the user —
 * it writes into the database already targeted by the URI. Make sure your PG
 * connection URI points at the destination database.
 */

import { argv, exit } from 'node:process';
import { decrypt } from '../src/crypto/encrypt.js';
import { prisma } from '../src/lib/prisma.js';
import { MongoReader } from '../src/migration/readers/mongo.reader.js';
import { PostgresWriter } from '../src/migration/writers/postgres.writer.js';
import { MongoToPostgresMapper } from '../src/migration/mappers/mongo-to-pg.mapper.js';
import { runMigration } from '../src/migration/pipeline.js';
import type { MigrationProgress } from '../src/migration/types.js';

interface Args {
  mongoId: string;
  pgId: string;
  database: string;
  destSchema: string;
  sampleSize: number;
  batchSize: number;
  drop: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Partial<Args> = {
    destSchema: 'public',
    sampleSize: 1000,
    batchSize: 1000,
    drop: false,
    dryRun: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    switch (k) {
      case '--mongo-id':    out.mongoId = v; i++; break;
      case '--pg-id':       out.pgId = v; i++; break;
      case '--database':    out.database = v; i++; break;
      case '--dest-schema': out.destSchema = v; i++; break;
      case '--sample-size': out.sampleSize = Number(v); i++; break;
      case '--batch-size':  out.batchSize = Number(v); i++; break;
      case '--drop':        out.drop = true; break;
      case '--dry-run':     out.dryRun = true; break;
      case '--help':
      case '-h':
        console.log(USAGE);
        exit(0);
    }
  }
  if (!out.mongoId || !out.pgId || !out.database) {
    console.error('Missing required args. Run with --help.');
    exit(1);
  }
  return out as Args;
}

const USAGE = `
Migrate Mongo → Postgres via the Phase 1A pipeline.

Required:
  --mongo-id   <id>   Connection row id for the Mongo source
  --pg-id      <id>   Connection row id for the Postgres destination
  --database   <db>   Name of the source Mongo database to migrate

Optional:
  --dest-schema <s>   Destination Postgres schema (default "public")
  --sample-size <n>   Docs sampled per collection for type inference (default 1000)
  --batch-size  <n>   Rows per COPY batch (default 1000)
  --drop              DROP TABLE IF EXISTS before CREATE TABLE
  --dry-run           Skip writes; only run inference + DDL preview
`.trim();

async function main() {
  const args = parseArgs();

  // Resolve connections + decrypt URIs.
  const [mongoConn, pgConn] = await Promise.all([
    prisma.connection.findUniqueOrThrow({ where: { id: args.mongoId } }),
    prisma.connection.findUniqueOrThrow({ where: { id: args.pgId } }),
  ]);

  if (mongoConn.dbType !== 'mongodb') {
    throw new Error(`--mongo-id points at a ${mongoConn.dbType} connection. Aborting.`);
  }
  if (pgConn.dbType !== 'postgres') {
    throw new Error(`--pg-id points at a ${pgConn.dbType} connection. Aborting.`);
  }

  const mongoUri = decrypt(mongoConn.encryptedUri);
  const pgUri    = decrypt(pgConn.encryptedUri);

  console.log(`▶ Mongo  source: ${mongoConn.name} → database "${args.database}"`);
  console.log(`▶ PG     dest:   ${pgConn.name} → schema "${args.destSchema}"`);
  console.log(`▶ sample=${args.sampleSize}  batch=${args.batchSize}  drop=${args.drop}  dryRun=${args.dryRun}`);
  console.log('');

  const reader = new MongoReader(mongoUri);
  const writer = new PostgresWriter(pgUri, {
    schemaName: args.destSchema,
    dropExisting: args.drop,
  });

  // Per-collection running counters for the live ticker.
  const lastTick = new Map<string, number>();

  const onProgress = (p: MigrationProgress) => {
    const key = `${p.namespace.database}.${p.namespace.name}`;
    const total = p.approxTotal ? `/${p.approxTotal}` : '';
    // Only print on phase change OR every ~5k written rows to avoid spam.
    const prev = lastTick.get(key) ?? -1;
    const tick = p.phase + '|' + Math.floor(p.written / 5000);
    if (prev === Number(hash(tick))) return;
    lastTick.set(key, Number(hash(tick)));
    console.log(`  [${p.phase.padEnd(12)}] ${key}  ${p.written}${total} written` +
      (p.skipped ? `, ${p.skipped} skipped` : '') +
      (p.failed ? `, ${p.failed} failed` : '') +
      (p.error ? `  ✕ ${p.error}` : ''));
  };

  const start = Date.now();
  const summary = await runMigration(
    reader, writer,
    (schema) => new MongoToPostgresMapper(schema),
    {
      database: args.database,
      sampleSize: args.sampleSize,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
      onProgress,
      onWarning: (w) => console.warn(`  ! [${w.severity}] ${w.code} ${w.namespace.name}.${w.column ?? ''} — ${w.message}`),
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

/** Tiny string hash for dedupe in the progress ticker. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

main().catch((err) => {
  console.error('Migration failed:', err);
  prisma.$disconnect().finally(() => exit(1));
});
