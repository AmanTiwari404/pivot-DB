import type {
  CanonicalType, DestRecord, InferredColumn, InferredSchema,
  RecordMapper, SchemaWarning, SourceRecord,
} from '../types.js';

/**
 * PostgreSQL → MySQL record mapper.
 *
 * The PG reader already normalises column values into their canonical JS shapes
 * (Date for timestamps, Buffer for bytea, plain objects for json/jsonb, etc.).
 * This mapper re-encodes them into the shapes MySqlWriter expects:
 *   - booleans → 0/1  (TINYINT(1))
 *   - json/jsonb/array → JSON.stringify string (MySQL JSON columns need strings)
 *   - Date → JS Date  (mysql2 handles DATETIME serialisation)
 *   - Buffer → Buffer (mysql2 handles BLOB serialisation)
 *   - decimal strings → pass through (MySQL DECIMAL accepts them)
 *
 * Schema translation is handled at the DDL level:
 *   JSONB→JSON, BYTEA→LONGBLOB, SERIAL→AUTO_INCREMENT, UUID→VARCHAR(36), etc.
 */
export class PostgresToMysqlMapper implements RecordMapper {
  private pending: SchemaWarning[] = [];

  constructor(private readonly schema: InferredSchema) {}

  translateSchema(source: InferredSchema): InferredSchema {
    return source;
  }

  mapRecord(rec: SourceRecord): DestRecord {
    const out: DestRecord = {};
    for (const col of this.schema.columns) {
      out[col.name] = coerce(rec[col.name], col, this.schema, (w) => this.pending.push(w));
    }
    return out;
  }

  drainWarnings(): SchemaWarning[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function coerce(
  v: unknown,
  col: InferredColumn,
  schema: InferredSchema,
  warn: (w: SchemaWarning) => void,
): unknown {
  if (v === null || v === undefined) return null;

  switch (col.type as CanonicalType) {
    case 'boolean':
      return v ? 1 : 0;

    case 'json':
    case 'jsonb':
    case 'array':
      if (typeof v === 'string') return v;
      try {
        return JSON.stringify(v);
      } catch (err) {
        warn({
          namespace: schema.namespace, column: col.name,
          severity: 'warn', code: 'json_stringify_failed',
          message: `JSON.stringify failed for "${col.name}": ${(err as Error).message}`,
        });
        return null;
      }

    case 'binary':
      if (Buffer.isBuffer(v)) return v;
      if (typeof v === 'string') return Buffer.from(v, 'base64');
      return null;

    case 'date':
    case 'timestamp':
      if (v instanceof Date) return v;
      if (typeof v === 'string' || typeof v === 'number') return new Date(v);
      return null;

    case 'decimal':
      return typeof v === 'string' ? v : String(v);

    case 'int':
    case 'long':
    case 'float':
    case 'double':
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return v.toString();
      return Number(v);

    case 'string':
    case 'uuid':
    case 'time':
    case 'objectid':
      return typeof v === 'string' ? v : String(v);

    case 'mixed':
    case 'unknown':
    case 'null':
      if (typeof v === 'object' && v !== null) {
        try { return JSON.stringify(v); } catch { return null; }
      }
      return typeof v === 'string' ? v : String(v);

    default:
      return v;
  }
}
