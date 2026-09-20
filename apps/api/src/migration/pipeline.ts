import type {
  DestRecord, MigrationProgress, NamespaceReader, NamespaceRef,
  NamespaceWriter, PipelineOptions, RecordMapper, SchemaWarning,
} from './types.js';

const DEFAULTS = {
  sampleSize: 1000,
  batchSize: 1000,
  parallelism: 1,
};

/**
 * Construct a mapper for the given (sourceType, destType) pair.
 * Wired up as a factory so the pipeline doesn't depend on every mapper
 * module — only the ones actually called are imported.
 */
export type MapperFactory = (sourceSchema: import('./types.js').InferredSchema) => RecordMapper;

/**
 * Run a migration end-to-end.
 *
 * Lifecycle per namespace:
 *   1. reader.inferSchema()        → discover columns + warnings
 *   2. mapper = makeMapper(schema) → derive destination shape
 *   3. writer.init(ns, destSchema) → DDL / create collection
 *   4. for batch of records:
 *        writer.writeBatch(ns, batch.map(mapper.mapRecord))
 *      → progress tick after every batch
 *   5. writer.finalize(ns)
 *
 * Resources are released in a `finally` regardless of failure path.
 *
 * Concurrency:
 *   - Default parallelism = 1 (serial) for predictable progress + simpler debugging.
 *   - Higher values run N namespaces in parallel via a bounded worker pool.
 *     Each namespace still streams serially within itself (to preserve order
 *     and keep checkpoints atomic).
 */
export async function runMigration(
  reader: NamespaceReader,
  writer: NamespaceWriter,
  makeMapper: MapperFactory,
  opts: PipelineOptions = {},
): Promise<MigrationSummary> {
  const sampleSize = opts.sampleSize ?? DEFAULTS.sampleSize;
  const batchSize  = opts.batchSize  ?? DEFAULTS.batchSize;
  const parallel   = Math.max(1, opts.parallelism ?? DEFAULTS.parallelism);

  // Resolve the working set of namespaces.
  let namespaces: NamespaceRef[];
  if (opts.namespaces && opts.namespaces.length > 0) {
    namespaces = opts.namespaces;
  } else {
    namespaces = await reader.listNamespaces(opts.database);
  }

  const summary: MigrationSummary = {
    namespaces: namespaces.length,
    succeeded: 0,
    failed: 0,
    totalWritten: 0,
    totalSkipped: 0,
    totalFailed: 0,
    warnings: [],
    errors: [],
  };

  const queue = [...namespaces];
  const workers: Promise<void>[] = [];

  const runOne = async (ns: NamespaceRef) => {
    const writtenBefore = summary.totalWritten;
    const failedBefore  = summary.totalFailed;
    try {
      await migrateNamespace(ns, reader, writer, makeMapper, {
        sampleSize, batchSize,
        onProgress: opts.onProgress, onWarning: (w) => {
          summary.warnings.push(w);
          opts.onWarning?.(w);
        },
        dryRun: opts.dryRun ?? false,
      }, summary);

      // Detect *silent* row-level failures — when the writer returned
      // `failed > 0` from one or more batches but the namespace didn't
      // throw. Without this, a run that lost 1800/4810 rows would still
      // be counted as fully succeeded and badged "succeeded" in the UI.
      const rowsFailed = summary.totalFailed - failedBefore;
      const rowsWritten = summary.totalWritten - writtenBefore;
      if (rowsFailed > 0) {
        // Pull root-cause message from the writer if it captured one.
        const writerErr = writer.getLastError?.(ns);
        summary.errors.push({
          namespace: ns,
          error: writerErr
            ? `${rowsFailed} row(s) failed: ${writerErr}`
            : `${rowsFailed} row(s) failed (no writer error captured)`,
        });
        // Count the namespace as failed only if NO rows landed; otherwise
        // it's a partial — succeeded counter still tracks "namespaces that
        // finished without throwing" which is the useful UI signal.
        if (rowsWritten === 0) summary.failed++;
        else                   summary.succeeded++;
      } else {
        summary.succeeded++;
      }
    } catch (err) {
      summary.failed++;
      summary.errors.push({ namespace: ns, error: String(err) });
      opts.onProgress?.({
        namespace: ns, phase: 'failed',
        written: 0, skipped: 0, failed: 0, error: String(err),
      });
    }
  };

  for (let i = 0; i < parallel; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const ns = queue.shift();
        if (!ns) return;
        await runOne(ns);
      }
    })());
  }

  try {
    await Promise.all(workers);
  } finally {
    // Always close readers + writers. Either succeeded or we're aborting.
    await reader.close().catch(() => {});
    await writer.close().catch(() => {});
  }

  return summary;
}

interface RunOpts {
  sampleSize: number;
  batchSize: number;
  onProgress?: (p: MigrationProgress) => void;
  onWarning?: (w: SchemaWarning) => void;
  dryRun: boolean;
}

async function migrateNamespace(
  ns: NamespaceRef,
  reader: NamespaceReader,
  writer: NamespaceWriter,
  makeMapper: MapperFactory,
  o: RunOpts,
  summary: MigrationSummary,
): Promise<void> {
  // ── Phase 1: infer schema ───────────────────────────────────────────────
  o.onProgress?.({
    namespace: ns, phase: 'inferring',
    written: 0, skipped: 0, failed: 0,
  });

  const inferred = await reader.inferSchema(ns, { sampleSize: o.sampleSize });
  inferred.warnings.forEach((w) => o.onWarning?.(w));

  const mapper = makeMapper(inferred);
  const destSchema = mapper.translateSchema(inferred);

  if (o.dryRun) {
    // No init, no streaming — caller just wanted DDL preview / warnings.
    o.onProgress?.({
      namespace: ns, phase: 'done',
      written: 0, skipped: 0, failed: 0, approxTotal: inferred.approxCount,
    });
    return;
  }

  // ── Phase 2: init destination (DDL / collection create) ─────────────────
  o.onProgress?.({
    namespace: ns, phase: 'initialising',
    written: 0, skipped: 0, failed: 0, approxTotal: inferred.approxCount,
  });
  await writer.init(ns, destSchema);

  // ── Phase 3: stream records in batches ──────────────────────────────────
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let batch: DestRecord[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const res = await writer.writeBatch(ns, batch);
    written += res.written;
    skipped += res.skipped;
    failed  += res.failed;
    batch = [];
    o.onProgress?.({
      namespace: ns, phase: 'streaming',
      written, skipped, failed,
      approxTotal: inferred.approxCount,
    });
    // Drain mapper warnings between batches so the UI sees them promptly.
    for (const w of mapper.drainWarnings()) o.onWarning?.(w);
  };

  for await (const doc of reader.read(ns)) {
    batch.push(mapper.mapRecord(doc));
    if (batch.length >= o.batchSize) await flush();
  }
  await flush();

  // ── Phase 4: finalize (ANALYZE, indexes, etc.) ──────────────────────────
  o.onProgress?.({
    namespace: ns, phase: 'finalising',
    written, skipped, failed,
    approxTotal: inferred.approxCount,
  });
  await writer.finalize(ns);

  summary.totalWritten += written;
  summary.totalSkipped += skipped;
  summary.totalFailed  += failed;

  o.onProgress?.({
    namespace: ns, phase: 'done',
    written, skipped, failed,
    approxTotal: inferred.approxCount,
  });
}

export interface MigrationSummary {
  namespaces: number;
  succeeded: number;
  failed: number;
  totalWritten: number;
  totalSkipped: number;
  totalFailed: number;
  warnings: SchemaWarning[];
  errors: Array<{ namespace: NamespaceRef; error: string }>;
}
