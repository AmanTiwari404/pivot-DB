import { ObjectId, Decimal128, Long } from 'mongodb';
import type {
  CanonicalType, DestRecord, InferredColumn, InferredSchema,
  RecordMapper, SchemaWarning, SourceRecord,
} from '../types.js';

const INT32_MAX =  2_147_483_647;
const INT32_MIN = -2_147_483_648;

/**
 * MySQL → Mongo mapper.
 *
 * Mirrors PostgresToMongoMapper — same composite-PK strategy, same FK-as-reference
 * default. MySQL-specific differences:
 *   - tinyint(1) is coerced to boolean (already mapped as canonical 'boolean').
 *   - datetime / timestamp → JS Date (mysql2 already converts these).
 *   - JSON columns → parsed if mysql2 returned a string.
 */
export class MysqlToMongoMapper implements RecordMapper {
  private readonly pkCols: InferredColumn[];
  private readonly useCompositePk: boolean;
  private pending: SchemaWarning[] = [];

  constructor(private readonly source: InferredSchema) {
    this.pkCols = source.columns.filter((c) => c.primaryKey);
    this.useCompositePk = this.pkCols.length > 1;
  }

  translateSchema(source: InferredSchema): InferredSchema {
    const out: InferredColumn[] = [];

    out.push({ name: '_id', type: 'objectid', nullable: false, primaryKey: true });

    if (this.useCompositePk) {
      out.push({ name: 'pk', type: 'jsonb', nullable: false });
    }

    for (const col of source.columns) {
      if (col.primaryKey && !this.useCompositePk) continue; // becomes _id
      out.push({ ...col, primaryKey: undefined });
    }

    return { ...source, columns: out };
  }

  mapRecord(rec: SourceRecord): DestRecord {
    const out: DestRecord = { _id: new ObjectId() };

    if (this.useCompositePk) {
      const pkSub: Record<string, unknown> = {};
      for (const pk of this.pkCols) pkSub[pk.name] = rec[pk.name];
      out.pk = pkSub;
    } else if (this.pkCols.length === 1) {
      // Single PK → _id carries its value (as string for portability).
      const pkVal = rec[this.pkCols[0].name];
      out._id = pkVal !== null && pkVal !== undefined ? String(pkVal) : new ObjectId();
    }

    for (const col of this.source.columns) {
      if (col.primaryKey && !this.useCompositePk) continue;
      const raw = rec[col.name];
      out[col.name] = coerceToMongo(raw, col, this.source, (w) => this.pending.push(w));
    }

    return out;
  }

  drainWarnings(): SchemaWarning[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function coerceToMongo(
  v: unknown,
  col: InferredColumn,
  schema: InferredSchema,
  warn: (w: SchemaWarning) => void,
): unknown {
  if (v === null || v === undefined) return null;

  switch (col.type) {
    case 'boolean':
      // mysql2 may return 0/1 for tinyint(1)
      if (typeof v === 'number') return v !== 0;
      return Boolean(v);

    case 'int':
      if (typeof v === 'number') return v >= INT32_MIN && v <= INT32_MAX ? v : Long.fromNumber(v);
      return parseInt(String(v), 10);

    case 'long':
      if (typeof v === 'bigint') return Long.fromBigInt(v);
      if (typeof v === 'number') return Long.fromNumber(v);
      return Long.fromString(String(v));

    case 'decimal':
      return Decimal128.fromString(String(v));

    case 'float':
    case 'double':
      return typeof v === 'number' ? v : parseFloat(String(v));

    case 'date':
    case 'timestamp':
      if (v instanceof Date) return v;
      if (typeof v === 'string' || typeof v === 'number') return new Date(v);
      return null;

    case 'binary':
      if (Buffer.isBuffer(v)) return v;
      if (typeof v === 'string') return Buffer.from(v, 'base64');
      return null;

    case 'json':
    case 'jsonb':
    case 'array':
      // mysql2 may return JSON columns as already-parsed objects, or as strings.
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;

    case 'string':
    case 'uuid':
    case 'objectid':
      return typeof v === 'string' ? v : String(v);

    case 'mixed':
    case 'unknown':
    case 'null':
    case 'time':
      if (typeof v === 'object') {
        warn({
          namespace: schema.namespace,
          column: col.name,
          severity: 'info',
          code: 'mixed_to_subdoc',
          message: `Field "${col.name}" mapped as mixed/unknown; stored as-is.`,
        });
      }
      return v;

    default: {
      const _: never = col.type;
      return v;
    }
  }
}
