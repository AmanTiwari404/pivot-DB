import type {
  CanonicalType, DestRecord, InferredColumn, InferredSchema,
  RecordMapper, SchemaWarning, SourceRecord,
} from '../types.js';

/**
 * MySQL → PostgreSQL record mapper.
 *
 * The MySQL reader normalises column values into canonical JS shapes
 * (Date for datetime, Buffer for blob, etc.). This mapper re-encodes them
 * into the shapes PostgresWriter (COPY FROM STDIN) expects:
 *   - boolean 0/1 → true/false  (PG COPY needs 't'/'f' text)
 *   - json/array → JSON.stringify string (PG COPY writer serialises JSONB)
 *   - Date → ISO string (PG COPY needs text timestamp)
 *   - Buffer → Buffer (PG COPY handles BYTEA buffers)
 *   - decimal → string (PG NUMERIC accepts decimal strings)
 *
 * Schema DDL translation is handled by the PostgresWriter + DDL generator:
 *   TINYINT(1)→BOOLEAN, BIGINT→BIGINT, TEXT→TEXT, JSON→JSONB, etc.
 */
export class MysqlToPostgresMapper implements RecordMapper {
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
      // mysql2 returns 0/1 for TINYINT(1); PG COPY needs true/false
      if (typeof v === 'number') return v !== 0;
      return Boolean(v);

    case 'json':
    case 'jsonb':
    case 'array':
      // mysql2 may return already-parsed objects; PG COPY needs JSON string
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
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'string') return v;
      return null;

    case 'timestamp':
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return new Date(v).toISOString();
      return null;

    case 'time':
      return typeof v === 'string' ? v : String(v);

    case 'decimal':
      return typeof v === 'string' ? v : String(v);

    case 'int':
    case 'long':
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'string') return v;
      return Number(v);

    case 'float':
    case 'double':
      if (typeof v === 'number') return v;
      return parseFloat(String(v));

    case 'string':
    case 'uuid':
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
