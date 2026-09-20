import type {
  CanonicalType, DestRecord, InferredColumn, InferredSchema,
  RecordMapper, SchemaWarning, SourceRecord,
} from '../types.js';
import { mysqlColumnList } from '../ddl/mysql-ddl.js';

/**
 * Mongo → MySQL record mapper.
 *
 * Structurally identical to MongoToPostgresMapper — the only difference is
 * the column-list helper (backtick quoting) and coercion paths that diverge
 * where MySQL differs from Postgres (e.g. no JSONB → JSON, no BYTEA → BLOB).
 */
export class MongoToMysqlMapper implements RecordMapper {
  private readonly columnOrder: string[];
  private readonly typeByColumn: Map<string, CanonicalType>;
  private pending: SchemaWarning[] = [];

  constructor(private readonly schema: InferredSchema) {
    this.columnOrder = mysqlColumnList(schema);
    this.typeByColumn = new Map();
    schema.columns.forEach((col, i) => {
      this.typeByColumn.set(this.columnOrder[i], col.type);
    });
  }

  translateSchema(source: InferredSchema): InferredSchema {
    // MySQL is typed; the inferred schema maps 1:1 to DDL columns.
    return source;
  }

  mapRecord(rec: SourceRecord): DestRecord {
    const out: DestRecord = {};
    for (let i = 0; i < this.schema.columns.length; i++) {
      const col = this.schema.columns[i];
      const destName = this.columnOrder[i];
      out[destName] = coerceToMysql(rec[col.name], col, this.schema, (w) => this.pending.push(w));
    }
    return out;
  }

  drainWarnings(): SchemaWarning[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function coerceToMysql(
  v: unknown,
  col: InferredColumn,
  schema: InferredSchema,
  warn: (w: SchemaWarning) => void,
): unknown {
  if (v === null || v === undefined) return null;

  // ObjectId → 24-char hex string
  if (typeof v === 'object' && v !== null && '_bsontype' in v && (v as { _bsontype: string })._bsontype === 'ObjectId') {
    return (v as unknown as { toHexString(): string }).toHexString();
  }

  switch (col.type) {
    case 'objectid':
      if (typeof v === 'object' && v !== null && 'toHexString' in (v as object)) {
        return (v as unknown as { toHexString(): string }).toHexString();
      }
      return String(v);

    case 'string':
    case 'mixed':
    case 'unknown':
    case 'null':
      if (typeof v === 'string') return v;
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);

    case 'int':
      if (typeof v === 'number') return Math.trunc(v);
      if (typeof v === 'bigint') return Number(v);
      return parseInt(String(v), 10);

    case 'long':
      if (typeof v === 'bigint') return Number(v);
      if (typeof v === 'number') return v;
      // BSON Long
      if (typeof v === 'object' && v !== null && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
      return parseInt(String(v), 10);

    case 'float':
    case 'double':
      return typeof v === 'number' ? v : parseFloat(String(v));

    case 'decimal':
      // BSON Decimal128 → string representation (MySQL DECIMAL accepts strings)
      if (typeof v === 'object' && v !== null && 'toString' in v) return (v as { toString(): string }).toString();
      return String(v);

    case 'boolean':
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v ? 1 : 0;

    case 'date':
    case 'timestamp':
      if (v instanceof Date) return v;
      if (typeof v === 'string' || typeof v === 'number') return new Date(v);
      return null;

    case 'binary':
      if (Buffer.isBuffer(v)) return v;
      if (typeof v === 'string') return Buffer.from(v, 'base64');
      if (typeof v === 'object' && v !== null && 'buffer' in v) return Buffer.from((v as { buffer: Buffer }).buffer);
      return Buffer.from(String(v));

    case 'uuid':
      return typeof v === 'string' ? v : String(v);

    case 'json':
    case 'jsonb':
    case 'array':
      if (typeof v === 'string') return v; // already stringified
      return JSON.stringify(v);

    default:
      if (typeof v === 'object') {
        warn({
          namespace: schema.namespace,
          column: col.name,
          severity: 'info',
          code: 'object_to_json',
          message: `Field "${col.name}" is an object; serialised as JSON string.`,
        });
        return JSON.stringify(v);
      }
      return String(v);
  }
}
