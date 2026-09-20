import type { Collection } from 'mongodb';
import type { CanonicalType, InferredColumn, InferredSchema, NamespaceRef, SchemaWarning } from '../types.js';

/**
 * Sample a Mongo collection and produce an InferredSchema.
 *
 * Strategy (matches the design doc's "B. Hybrid"):
 *   - Walk N sampled docs (default 1000) collected via $sample.
 *   - For each top-level field, track presence count + every distinct BSON type seen.
 *   - Promote single-type fields to their canonical SQL type.
 *   - Fields with multiple observed types become 'mixed' (DDL widens to TEXT/JSONB).
 *   - Nested objects + arrays become 'jsonb' by default; user can promote in UI later.
 *   - _id is always a primary-key column of type 'objectid' (string in SQL).
 */
export async function sampleMongoCollection(
  coll: Collection,
  ns: NamespaceRef,
  opts: { sampleSize: number },
): Promise<InferredSchema> {
  const sampleSize = Math.max(1, opts.sampleSize);
  const warnings: SchemaWarning[] = [];

  // estimatedDocumentCount is cheap; an exact count() can be very slow on
  // large sharded collections, so we use the estimate as approxCount only.
  const approxCount = await coll.estimatedDocumentCount().catch(() => undefined);

  // $sample is O(N) in the sample size, not the collection size — safe at scale.
  // For tiny collections (< sample size) Mongo just returns everything.
  const pipeline = [{ $sample: { size: sampleSize } }];
  const docs = await coll.aggregate(pipeline, { allowDiskUse: true }).toArray()
    .catch(() => [] as Array<Record<string, unknown>>);

  // Per-field stats accumulator.
  // We keep a Set of canonical types per field; size > 1 means mixed.
  const stats = new Map<string, { presence: number; types: Set<CanonicalType> }>();

  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const entry = stats.get(key) ?? { presence: 0, types: new Set<CanonicalType>() };
      entry.presence++;
      entry.types.add(canonicalBsonType(value));
      stats.set(key, entry);
    }
  }

  const docCount = docs.length;
  const columns: InferredColumn[] = [];

  for (const [name, info] of stats.entries()) {
    const observedTypes = Array.from(info.types);
    // Resolve final canonical type:
    //   - exactly one observed type → that type
    //   - one type + 'null' → that type (nullable)
    //   - two+ non-null types → 'mixed'
    const nonNullTypes = observedTypes.filter((t) => t !== 'null');
    let resolved: CanonicalType;
    if (nonNullTypes.length === 0) resolved = 'null';
    else if (nonNullTypes.length === 1) resolved = nonNullTypes[0];
    else resolved = 'mixed';

    if (resolved === 'mixed') {
      warnings.push({
        namespace: ns,
        column: name,
        severity: 'warn',
        code: 'mixed_type_field',
        message:
          `Field "${name}" had multiple BSON types in the sample (${nonNullTypes.join(', ')}). ` +
          `It will be stored as TEXT (or JSONB if any observed type was object/array).`,
      });
    }
    if (resolved === 'null') {
      warnings.push({
        namespace: ns,
        column: name,
        severity: 'info',
        code: 'all_null_field',
        message:
          `Field "${name}" was always null in the sample. ` +
          `It will be created as a nullable TEXT column — change in mapping if needed.`,
      });
    }

    columns.push({
      name,
      type: resolved,
      // Nullable if ANY of:
      //   • some sampled docs were missing the field entirely (presence < docCount)
      //   • the only observed value was null (resolved === 'null')
      //   • the field was sometimes present-but-null (observedTypes includes 'null')
      // The third case used to be missed, which produced NOT NULL columns that
      // then rejected nulls during the full streamed load — the classic
      // "0 written / N failed" symptom on collections with sparse-value fields.
      nullable: info.presence < docCount
              || resolved === 'null'
              || observedTypes.includes('null'),
      primaryKey: name === '_id',
      presenceCount: info.presence,
      observedTypes: nonNullTypes.length > 1 ? nonNullTypes : undefined,
    });
  }

  // If we sampled zero docs (empty collection), still emit a minimal schema with _id
  // so DDL gen can produce a usable table the user can later append into.
  if (columns.length === 0) {
    columns.push({ name: '_id', type: 'objectid', nullable: false, primaryKey: true });
    warnings.push({
      namespace: ns,
      severity: 'info',
      code: 'empty_collection',
      message: `Collection "${ns.database}.${ns.name}" was empty in the sample. ` +
        `Only the _id column will be created.`,
    });
  }

  return { namespace: ns, approxCount, columns, warnings };
}

/** Map a JavaScript / BSON value to a CanonicalType token. */
export function canonicalBsonType(v: unknown): CanonicalType {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'timestamp';
  if (typeof v === 'object') {
    const o = v as { _bsontype?: string };
    switch (o._bsontype) {
      case 'ObjectId':    return 'objectid';
      case 'Decimal128':  return 'decimal';
      case 'Long':        return 'long';
      case 'Binary':      return 'binary';
      case 'Double':      return 'double';
      case 'Int32':       return 'int';
      case 'UUID':        return 'uuid';
      default:            return 'jsonb'; // plain nested object — store as JSONB
    }
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string')  return 'string';
  return 'unknown';
}
