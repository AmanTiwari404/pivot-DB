import { ObjectId, Decimal128, Long, Binary, UUID } from 'mongodb';
import type {
  CanonicalType, DestRecord, InferredColumn, InferredSchema,
  RecordMapper, SchemaWarning, SourceRecord,
} from '../types.js';

const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

/**
 * Postgres → Mongo mapper.
 *
 * Responsibilities:
 *   1. translateSchema()
 *      - decides _id strategy (single PK column ↔ composite PK with subdoc)
 *      - emits warnings for FK-as-reference vs embed (Phase 1D adds UI override;
 *        for now we default to "reference" = preserve as a field)
 *   2. mapRecord()
 *      - per-column value coercion using the source InferredColumn metadata
 *      - composite PK → generated ObjectId + `pk` subdocument
 *      - PG JSON/JSONB strings → parsed subdocuments
 *      - numeric → Decimal128 (lossless), bigint → Long when > INT32
 */
export class PostgresToMongoMapper implements RecordMapper {
  private readonly source: InferredSchema;
  private readonly pkCols: InferredColumn[];
  private readonly useCompositePk: boolean;
  private pending: SchemaWarning[] = [];

  constructor(source: InferredSchema) {
    this.source = source;
    this.pkCols = source.columns.filter((c) => c.primaryKey);
    this.useCompositePk = this.pkCols.length > 1;
  }

  /**
   * Translate the source SQL schema into a destination-side InferredSchema.
   * For Mongo this is mostly cosmetic — the writer only cares about indexes,
   * not column types — but we still produce a real InferredSchema so the
   * writer can build the right indexes during init().
   */
  translateSchema(source: InferredSchema): InferredSchema {
    const out: InferredColumn[] = [];

    // Always emit _id first.
    out.push({
      name: '_id',
      type: 'objectid',
      nullable: false,
      primaryKey: true,
    });

    // Composite PK → emit a `pk` subdocument column (canonical type 'jsonb').
    // Mongo doesn't enforce structure here, but we mark it so writer.init()
    // creates the compound unique index on pk.<col1>, pk.<col2>...
    if (this.useCompositePk) {
      out.push({
        name: 'pk',
        type: 'jsonb',
        nullable: false,
        // Encode the original PK columns in observedTypes so writer.init can
        // build the compound index without re-reading the source schema.
        observedTypes: this.pkCols.map((c) => c.name) as unknown as CanonicalType[],
      });
    }

    // Source columns pass through, except the PK col(s) if we're using
    // composite (those move into `pk`). For single-column PK we KEEP the
    // column AND make it _id.
    for (const col of source.columns) {
      if (this.useCompositePk && col.primaryKey) continue;
      if (!this.useCompositePk && col.primaryKey) continue; // becomes _id above
      out.push({ ...col });
    }

    // Warn about FK columns staying as plain references.
    for (const col of source.columns) {
      if (col.references) {
        this.pending.push({
          namespace: source.namespace,
          column: col.name,
          severity: 'info',
          code: 'fk_kept_as_reference',
          message:
            `Column "${col.name}" references ${col.references}. ` +
            `It will be migrated as a plain field on each document — use the mapping UI ` +
            `to embed the referenced rows instead.`,
        });
      }
    }

    return {
      namespace: { database: source.namespace.database, name: source.namespace.name },
      approxCount: source.approxCount,
      columns: out,
      warnings: [...source.warnings],
    };
  }

  mapRecord(rec: SourceRecord): DestRecord {
    const out: DestRecord = {};

    // ── Primary key strategy ───────────────────────────────────────────────
    if (this.useCompositePk) {
      // Composite PK → generated _id + `pk` subdocument carrying the original keys.
      out._id = new ObjectId();
      const pkSubdoc: Record<string, unknown> = {};
      for (const col of this.pkCols) {
        pkSubdoc[col.name] = coerceValue(rec[col.name], col, (w) => this.pending.push(w));
      }
      out.pk = pkSubdoc;
    } else if (this.pkCols.length === 1) {
      // Single-column PK becomes _id, preserving its native type.
      // (Numeric IDs land as numbers; uuid/text IDs land as strings.)
      out._id = coerceValue(rec[this.pkCols[0].name], this.pkCols[0], (w) => this.pending.push(w));
    } else {
      // No declared PK → fabricate one. Source row order is not preserved,
      // but that's already true of SQL — no guarantee without ORDER BY.
      out._id = new ObjectId();
    }

    // ── Body columns ───────────────────────────────────────────────────────
    for (const col of this.source.columns) {
      // Skip PK columns if we already encoded them above.
      if (this.useCompositePk && col.primaryKey) continue;
      if (!this.useCompositePk && col.primaryKey) continue;
      out[col.name] = coerceValue(rec[col.name], col, (w) => this.pending.push(w));
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
 * Coerce a single PG-driver-produced JS value into a BSON-friendly value.
 *
 * The `pg` driver already returns sensible JS types for most PG types:
 *   - int/float → number
 *   - bigint    → string (we promote to BSON Long if it exceeds INT32 range)
 *   - bool      → boolean
 *   - text/varchar/uuid → string
 *   - date/timestamp/timestamptz → Date
 *   - bytea     → Buffer
 *   - json/jsonb → already parsed (object/array/number/string)
 *   - arrays    → JS Array (with parsed elements)
 *
 * We do the minimum extra work:
 *   - decimal/numeric → Decimal128 (pg returns string; preserve precision)
 *   - bigint > INT32  → Long
 *   - bytea → BSON Binary
 *   - uuid → string (we don't construct BSON UUID by default; strings round-trip everywhere)
 */
function coerceValue(
  v: unknown,
  col: InferredColumn,
  warn: (w: SchemaWarning) => void,
): unknown {
  if (v === null || v === undefined) return null;

  switch (col.type) {
    case 'string':
    case 'mixed':
    case 'unknown':
    case 'null':
      return typeof v === 'string' ? v : String(v);

    case 'int':
      return typeof v === 'number' ? v : Number(v);

    case 'long': {
      // pg returns BIGINT as a string to avoid JS precision loss.
      const s = String(v);
      const n = Number(s);
      if (Number.isFinite(n) && n >= INT32_MIN && n <= INT32_MAX && Number.isInteger(n)) return n;
      try {
        return Long.fromString(s);
      } catch {
        warn({
          namespace: { database: '', name: '' }, column: col.name,
          severity: 'warn', code: 'long_coerce_failed',
          message: `Could not parse BIGINT "${s}" — stored as string.`,
        });
        return s;
      }
    }

    case 'float':
    case 'double':
      return typeof v === 'number' ? v : Number(v);

    case 'decimal': {
      // pg returns NUMERIC as a string. Decimal128 keeps full precision.
      try {
        return Decimal128.fromString(String(v));
      } catch {
        warn({
          namespace: { database: '', name: '' }, column: col.name,
          severity: 'warn', code: 'decimal_coerce_failed',
          message: `Could not parse NUMERIC "${String(v)}" as Decimal128 — stored as string.`,
        });
        return String(v);
      }
    }

    case 'boolean':
      return Boolean(v);

    case 'date':
    case 'timestamp':
      if (v instanceof Date) return v;
      return new Date(String(v));

    case 'time':
      return String(v);

    case 'binary':
      if (Buffer.isBuffer(v)) return new Binary(v, Binary.SUBTYPE_DEFAULT);
      return new Binary(Buffer.from(String(v)), Binary.SUBTYPE_DEFAULT);

    case 'uuid':
      // Store as string for portability. Construct BSON UUID instead if the
      // user opts in via mapping UI (Phase 1D).
      return typeof v === 'string' ? v : String(v);

    case 'objectid':
      return typeof v === 'string' ? v : String(v);

    case 'json':
    case 'jsonb':
      // pg parses JSON/JSONB into JS objects automatically. Passthrough.
      return v;

    case 'array':
      // pg parses arrays into JS arrays. Passthrough.
      return Array.isArray(v) ? v : [v];
  }
}

// We import UUID only to keep it available for future opt-in mapping; suppress
// the "declared but never used" diagnostic.
void UUID;
