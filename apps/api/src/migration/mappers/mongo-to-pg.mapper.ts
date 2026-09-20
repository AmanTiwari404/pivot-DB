import type {
  CanonicalType, DestRecord, InferredColumn, InferredSchema,
  RecordMapper, SchemaWarning, SourceRecord,
} from '../types.js';
import { pgColumnList } from '../ddl/postgres-ddl.js';

/**
 * Mongo → Postgres record mapper.
 *
 * Holds the InferredSchema produced by sampling, derives the column order
 * once, then transforms each doc into a *plain object whose keys match the
 * destination column order*. The Postgres writer takes that object, looks up
 * each column by name, and serialises into the COPY tab-separated format.
 *
 * Per-doc warnings (field present but unexpected type, value too large, …)
 * are accumulated in `pending` and drained by the pipeline between batches.
 */
export class MongoToPostgresMapper implements RecordMapper {
  private readonly columnOrder: string[];
  private readonly typeByColumn: Map<string, CanonicalType>;
  private pending: SchemaWarning[] = [];

  constructor(private readonly schema: InferredSchema) {
    this.columnOrder = pgColumnList(schema);
    this.typeByColumn = new Map();
    // Pair sanitized column names with their canonical types. We keep both
    // because the source doc still has the *raw* Mongo field names.
    schema.columns.forEach((col, i) => {
      this.typeByColumn.set(this.columnOrder[i], col.type);
    });
  }

  /**
   * For Mongo→PG the destination schema IS the inferred source schema — there
   * are no FK rules or renames at this layer. The DDL generator handles the
   * dialect translation downstream.
   */
  translateSchema(source: InferredSchema): InferredSchema {
    return source;
  }

  mapRecord(rec: SourceRecord): DestRecord {
    const out: DestRecord = {};
    for (let i = 0; i < this.schema.columns.length; i++) {
      const col = this.schema.columns[i];
      const sanitizedName = this.columnOrder[i];
      const value = rec[col.name];
      out[sanitizedName] = coerce(value, col, this.schema, (w) => this.pending.push(w));
    }
    return out;
  }

  drainWarnings(): SchemaWarning[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/**
 * Coerce a Mongo value into something the Postgres writer can serialise.
 *
 * Each canonical type has a small set of expected JS shapes (ObjectId object,
 * Date, BigInt, string, etc). We normalise to the *minimal* representation
 * the COPY layer can handle: primitives, strings, ISO timestamps, Buffers,
 * and JSON-stringified objects/arrays. Unknown shapes degrade to JSON.stringify
 * with a warning so the user can investigate later.
 */
function coerce(
  v: unknown,
  col: InferredColumn,
  schema: InferredSchema,
  warn: (w: SchemaWarning) => void,
): unknown {
  if (v === null || v === undefined) return null;

  switch (col.type) {
    case 'string':
    case 'mixed':
    case 'unknown':
    case 'null':
      // Stringify anything non-string for these tolerant buckets.
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return JSON.stringify(v);

    case 'int':
    case 'long': {
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return v.toString();
      // BSON Long has toString(); BSON Int32 has valueOf().
      const o = v as { toString?: () => string; valueOf?: () => number };
      if (typeof o.toString === 'function') return o.toString();
      return null;
    }

    case 'float':
    case 'double': {
      if (typeof v === 'number') return v;
      const o = v as { valueOf?: () => number };
      return typeof o.valueOf === 'function' ? o.valueOf() : null;
    }

    case 'decimal': {
      // BSON Decimal128.toString() produces a numeric string Postgres accepts.
      const o = v as { toString?: () => string };
      return typeof o.toString === 'function' ? o.toString() : String(v);
    }

    case 'boolean':
      return Boolean(v);

    case 'date':
    case 'timestamp':
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return new Date(v).toISOString();
      return null;

    case 'time':
      return typeof v === 'string' ? v : String(v);

    case 'binary': {
      // BSON Binary has .buffer or .value(true) → Buffer.
      const o = v as { buffer?: Buffer; value?: (raw: boolean) => Buffer };
      if (o.buffer) return o.buffer;
      if (typeof o.value === 'function') return o.value(true);
      if (Buffer.isBuffer(v)) return v;
      warn({
        namespace: schema.namespace, column: col.name,
        severity: 'warn', code: 'binary_coerce_failed',
        message: `Could not extract bytes from BSON Binary field "${col.name}". ` +
                 `Value stored as JSON instead.`,
      });
      return JSON.stringify(v);
    }

    case 'uuid':
      // BSON UUID has toString() producing canonical 8-4-4-4-12 form.
      // String values pass through.
      if (typeof v === 'string') return v;
      return (v as { toString: () => string }).toString();

    case 'objectid':
      // Canonical 24-char hex.
      return (v as { toHexString?: () => string; toString: () => string })
        .toHexString?.() ?? (v as { toString: () => string }).toString();

    case 'json':
    case 'jsonb':
    case 'array':
      // Always serialize; COPY writer puts this directly into the JSONB column.
      try {
        return JSON.stringify(v, jsonReplacer);
      } catch (err) {
        warn({
          namespace: schema.namespace, column: col.name,
          severity: 'warn', code: 'json_stringify_failed',
          message: `JSON.stringify failed on "${col.name}": ${(err as Error).message}. ` +
                   `Row inserted with NULL in this column.`,
        });
        return null;
      }
  }
}

/**
 * JSON.stringify replacer that handles BSON-specific types so nested
 * ObjectIds / Dates / Decimals don't render as opaque objects.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') {
    const o = value as { _bsontype?: string; toHexString?: () => string; toString?: () => string };
    if (o._bsontype === 'ObjectId') return o.toHexString?.() ?? o.toString?.();
    if (o._bsontype === 'Decimal128') return o.toString?.();
    if (o._bsontype === 'Long') return o.toString?.();
    if (value instanceof Date) return value.toISOString();
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
