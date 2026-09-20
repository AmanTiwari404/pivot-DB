import { Worker, Job } from 'bullmq';
import { createWriteStream, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pipeline, finished } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import path from 'node:path';
import { stringify } from 'csv-stringify';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { getFreshClient } from '../lib/mongo.js';
import { runSqlTableExport, runSqlSchemaExport } from './sql-export.job.js';

// tar is CJS — require it
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tar = require('tar') as any;

const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/mongovis';

// ── BSON-safe JSON serialiser ─────────────────────────────────────────────────
// Avoids bson package version conflicts by using a custom replacer.
// Handles ObjectId, Date, Decimal128, Binary, Long, etc.
function docToJson(doc: unknown): string {
  return JSON.stringify(doc, (_key, val) => {
    if (val === null || val === undefined) return val;
    // ObjectId / any object with a toHexString method → string
    if (typeof val === 'object' && typeof val.toHexString === 'function') return val.toHexString();
    // Date → ISO string
    if (val instanceof Date) return val.toISOString();
    // Decimal128 / Long → string via toString
    if (typeof val === 'object' && typeof val.toString === 'function' &&
        val.constructor?.name && ['Decimal128', 'Long', 'Int32', 'Double'].includes(val.constructor.name)) {
      return val.toString();
    }
    // Binary → base64
    if (typeof val === 'object' && val.constructor?.name === 'Binary' && val.buffer) {
      return Buffer.from(val.buffer).toString('base64');
    }
    return val;
  });
}

// ── Transforms ────────────────────────────────────────────────────────────────

function jsonArrayTransform() {
  let first = true;
  return new Transform({
    objectMode: true,
    transform(doc, _enc, cb) {
      const json = docToJson(doc);
      const chunk = first ? '[\n' + json : ',\n' + json;
      first = false;
      cb(null, chunk);
    },
    flush(cb) {
      cb(null, first ? '[]' : '\n]');
    },
  });
}

// ── Single-collection export ──────────────────────────────────────────────────

async function runCollectionExport(jobId: string) {
  const exportJob = await prisma.exportJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { connection: true },
  });

  const uri    = decrypt(exportJob.connection.encryptedUri);
  const client = await getFreshClient(uri);
  const db     = client.db(exportJob.database);
  const collName = exportJob.collection!;
  const coll   = db.collection(collName);

  const query           = exportJob.query as Record<string, unknown>;
  const pipelineStages  = exportJob.isPipeline ? (query as unknown as unknown[]) : undefined;
  const filter          = exportJob.isPipeline ? {} : query;

  mkdirSync(TEMP_DIR, { recursive: true });
  const ext       = exportJob.format === 'csv' ? 'csv' : 'json';
  const fileKey   = path.join(TEMP_DIR, `export_${jobId}.${ext}`);
  const outStream = createWriteStream(fileKey);

  const cursor = pipelineStages
    ? coll.aggregate(pipelineStages as Parameters<typeof coll.aggregate>[0])
    : coll.find(filter);

  const docStream = Readable.from(cursor as AsyncIterable<Record<string, unknown>>);

  if (exportJob.format === 'csv') {
    const opts = exportJob.options as { delimiter?: string; header?: boolean };
    const csvStream = stringify({ delimiter: opts.delimiter ?? ',', header: opts.header !== false });
    await pipeline(docStream, csvStream, outStream);
  } else {
    await pipeline(docStream, jsonArrayTransform(), outStream);
  }

  await client.close();
  return fileKey;
}

// ── Database export (tar.gz with one file per collection) ─────────────────────

async function runDatabaseExport(jobId: string) {
  const exportJob = await prisma.exportJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { connection: true },
  });

  const uri    = decrypt(exportJob.connection.encryptedUri);
  const client = await getFreshClient(uri);
  const db     = client.db(exportJob.database);

  const options         = exportJob.options as { excludeCollections?: string[]; includeIndexes?: boolean; includeMetadata?: boolean };
  const excludeSet      = new Set(options.excludeCollections ?? []);
  const includeIndexes  = options.includeIndexes !== false;
  const includeMetadata = options.includeMetadata !== false;

  // List collections, excluding system and user-excluded ones
  const allCollections = await db.listCollections().toArray();
  const collectionNames = allCollections
    .map(c => c.name)
    .filter(name => !excludeSet.has(name) && !name.startsWith('system.'));

  // Write each collection to a staging directory, then pack into tar.gz
  mkdirSync(TEMP_DIR, { recursive: true });
  const stagingDir = mkdtempSync(path.join(tmpdir(), `export-${jobId}-`));

  const metadata: Record<string, unknown> = {};

  try {
    for (const colName of collectionNames) {
      const collection = db.collection(colName);

      if (includeMetadata || includeIndexes) {
        const [count, indexes] = await Promise.all([
          collection.countDocuments(),
          includeIndexes ? collection.indexes() : Promise.resolve([]),
        ]);
        metadata[colName] = { count, ...(includeIndexes ? { indexes } : {}) };
      }

      if (exportJob.format === 'json') {
        // Build NDJSON file sequentially
        const filePath = path.join(stagingDir, `${colName}.json`);
        const out = createWriteStream(filePath);
        const cursor = collection.find({});
        let first = true;
        out.write('[\n');
        await cursor.forEach((doc) => {
          const json = docToJson(doc);
          out.write(first ? json : ',\n' + json);
          first = false;
        });
        out.end(first ? ']' : '\n]');
        await finished(out);

      } else {
        // CSV — load docs, build header + rows
        const docs = await collection.find({}).toArray();
        const filePath = path.join(stagingDir, `${colName}.csv`);

        if (docs.length === 0) {
          writeFileSync(filePath, '');
          continue;
        }

        const keySet = new Set<string>();
        for (const doc of docs) {
          for (const k of Object.keys(doc)) keySet.add(k);
        }
        const headers = [...keySet];
        const rows = docs.map(doc =>
          headers.map(h => {
            const val = (doc as Record<string, unknown>)[h];
            if (val === null || val === undefined) return '';
            if (typeof val === 'object') return JSON.stringify(val);
            return String(val);
          }).join(',')
        );
        writeFileSync(filePath, [headers.join(','), ...rows].join('\n'));
      }
    }

    // Metadata file
    if (includeMetadata && Object.keys(metadata).length > 0) {
      writeFileSync(path.join(stagingDir, '_metadata.json'), JSON.stringify(metadata, null, 2));
    }

    // Pack staging dir into tar.gz
    const fileKey = path.join(TEMP_DIR, `export_${jobId}.tar.gz`);
    await tar.create(
      { gzip: true, file: fileKey, cwd: stagingDir },
      await import('node:fs').then(({ readdirSync }) => readdirSync(stagingDir)),
    );

    await client.close();
    return fileKey;
  } finally {
    // Clean up staging dir
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

// ── BullMQ Worker ─────────────────────────────────────────────────────────────

export function startExportWorker() {
  return new Worker('export', async (job: Job) => {
    const { jobId } = job.data as { jobId: string };

    const exportJob = await prisma.exportJob.findUniqueOrThrow({ where: { id: jobId } });
    await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'running' } });

    const run = await prisma.jobRun.create({
      data: { exportJobId: jobId, jobType: 'export', status: 'running' },
    });

    try {
      let fileKey: string;

      // Dispatch by engine: Mongo connections use the original
      // collection/database export paths; SQL connections use the
      // PostgresReader / MySqlReader-backed runners.
      const conn = await prisma.connection.findUniqueOrThrow({
        where: { id: exportJob.connectionId },
        select: { dbType: true },
      });
      const isSql = conn.dbType === 'postgres' || conn.dbType === 'mysql';

      if (isSql) {
        fileKey = exportJob.exportType === 'database'
          ? await runSqlSchemaExport(jobId)
          : await runSqlTableExport(jobId);
      } else if (exportJob.exportType === 'database') {
        fileKey = await runDatabaseExport(jobId);
      } else {
        fileKey = await runCollectionExport(jobId);
      }

      await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'done', fileKey } });
      await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'success', finishedAt: new Date() } });
    } catch (err) {
      await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'failed' } });
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), errorReport: { error: String(err) } as object },
      });
      throw err;
    }
  }, { connection: redis });
}
