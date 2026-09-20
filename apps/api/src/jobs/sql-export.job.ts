/**
 * SQL export runner — Phase 3A.
 *
 * Streams rows out of a Postgres or MySQL table (or all tables in a schema)
 * into a CSV or JSON file under TEMP_DIR. Reuses the Phase 1 reader infra
 * (PostgresReader / MySqlReader) for cursor-based reads, so memory stays
 * bounded for very large tables.
 *
 * The Mongo export job stays untouched in `export.job.ts`. The shared worker
 * in `export.job.ts` dispatches here based on `connection.dbType`.
 */

import { createWriteStream, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stringify } from 'csv-stringify';
import { Decimal128 } from 'mongodb';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { PostgresReader } from '../migration/readers/postgres.reader.js';
import { MySqlReader } from '../migration/readers/mysql.reader.js';
import type { NamespaceReader, NamespaceRef } from '../migration/types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tar = require('tar') as any;

const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/mongovis';

/**
 * Build a reader for a SQL connection. `database` here is the PG schema name
 * for Postgres, and the actual database name for MySQL — matching the
 * convention used by the migration pipeline.
 */
function makeSqlReader(dbType: string, uri: string, database: string): NamespaceReader {
  if (dbType === 'postgres') return new PostgresReader(uri, { schemaName: database });
  if (dbType === 'mysql')    return new MySqlReader(uri, { dbName: database });
  throw new Error(`Unsupported SQL dbType for export: ${dbType}`);
}

/**
 * Serialise a single SQL row value into something `csv-stringify` and
 * `JSON.stringify` won't choke on.
 *
 * The pg + mysql2 drivers already do most of the work — they hand back
 * numbers/strings/booleans/Date/Buffer/parsed JSON. We only need to handle
 * the long-tail BSON-ish types that might sneak in (Decimal128 from PG
 * NUMERIC columns when the user pulls via a tool that wraps them) and Buffers.
 */
function rowValueToString(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (v instanceof Decimal128) return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * Pull all rows from `ns` and write either a CSV (with header) or a
 * JSON array file at `outPath`. Returns the column order discovered.
 */
async function writeNamespaceFile(
  reader: NamespaceReader,
  ns: NamespaceRef,
  outPath: string,
  format: 'csv' | 'json',
  csvOpts: { delimiter?: string; header?: boolean },
): Promise<void> {
  // Pull declared schema first so the column order in CSV matches what
  // the user sees in their DB tool, not the iteration order of the first row.
  const inferred = await reader.inferSchema(ns, { sampleSize: 1 });
  const columns = inferred.columns.map((c) => c.name);

  mkdirSync(path.dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath);

  if (format === 'csv') {
    const csv = stringify({
      delimiter: csvOpts.delimiter ?? ',',
      header: csvOpts.header !== false,
      columns,
    });
    csv.pipe(out);
    for await (const row of reader.read(ns)) {
      const serialised: Record<string, unknown> = {};
      for (const col of columns) serialised[col] = rowValueToString(row[col]);
      csv.write(serialised);
    }
    csv.end();
    await new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
    return;
  }

  // JSON array — write header bracket, comma-separated rows, closing bracket.
  out.write('[\n');
  let first = true;
  for await (const row of reader.read(ns)) {
    const serialised: Record<string, unknown> = {};
    for (const col of columns) serialised[col] = rowValueToString(row[col]);
    const chunk = (first ? '' : ',\n') + JSON.stringify(serialised);
    first = false;
    out.write(chunk);
  }
  out.write(first ? ']' : '\n]');
  out.end();
  await new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
}

/** Single-table SQL export — writes one CSV/JSON file at TEMP_DIR. */
export async function runSqlTableExport(jobId: string): Promise<string> {
  const job = await prisma.exportJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { connection: true },
  });
  if (!job.collection) throw new Error('Single-table SQL export requires a `collection` (table name)');

  const uri = decrypt(job.connection.encryptedUri);
  const reader = makeSqlReader(job.connection.dbType, uri, job.database);
  const ns: NamespaceRef = { database: job.database, name: job.collection };

  const ext = job.format === 'csv' ? 'csv' : 'json';
  const outPath = path.join(TEMP_DIR, `export_${jobId}.${ext}`);

  try {
    await writeNamespaceFile(reader, ns, outPath, job.format as 'csv' | 'json',
      (job.options as { delimiter?: string; header?: boolean }) ?? {});
    return outPath;
  } finally {
    await reader.close();
  }
}

/** Schema-level SQL export — writes a tar.gz with one file per table. */
export async function runSqlSchemaExport(jobId: string): Promise<string> {
  const job = await prisma.exportJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { connection: true },
  });

  const uri = decrypt(job.connection.encryptedUri);
  const reader = makeSqlReader(job.connection.dbType, uri, job.database);

  const options = (job.options as { excludeCollections?: string[] }) ?? {};
  const excludeSet = new Set(options.excludeCollections ?? []);

  mkdirSync(TEMP_DIR, { recursive: true });
  const stagingDir = mkdtempSync(path.join(tmpdir(), `export-${jobId}-`));

  try {
    const namespaces = await reader.listNamespaces(job.database);
    const filtered = namespaces.filter((n) => !excludeSet.has(n.name));

    for (const ns of filtered) {
      const ext = job.format === 'csv' ? 'csv' : 'json';
      const filePath = path.join(stagingDir, `${ns.name}.${ext}`);
      await writeNamespaceFile(reader, ns, filePath, job.format as 'csv' | 'json',
        (job.options as { delimiter?: string; header?: boolean }) ?? {});
    }

    const fileKey = path.join(TEMP_DIR, `export_${jobId}.tar.gz`);
    await tar.create(
      { gzip: true, file: fileKey, cwd: stagingDir },
      readdirSync(stagingDir),
    );
    return fileKey;
  } finally {
    await reader.close();
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}
