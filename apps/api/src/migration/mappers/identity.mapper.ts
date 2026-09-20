/**
 * Identity mapper — used for same-engine migrations (Mongo→Mongo, PG→PG,
 * MySQL→MySQL).
 *
 * Cross-engine mappers do real translation work:
 *   - rename incompatible types (Mongo Decimal128 → SQL NUMERIC)
 *   - flatten or stringify nested objects/arrays
 *   - encode binary blobs in the dest's preferred shape
 *   - drop columns the dest can't represent
 *
 * For same-engine migrations none of that is needed — the destination
 * speaks the exact same dialect as the source, so we just pass records
 * through unchanged. The schema descriptor is copied verbatim.
 *
 * Why we still need a mapper at all (vs. wiring reader→writer directly):
 *   The pipeline (pipeline.ts) is parameterised on a `RecordMapper` so
 *   `init()` gets a destination-side schema descriptor. Same-engine just
 *   means "destination schema == source schema."
 */

import type {
  RecordMapper, InferredSchema, SourceRecord, DestRecord, SchemaWarning,
} from '../types.js';

export class IdentityMapper implements RecordMapper {
  constructor(_schema: InferredSchema) {
    // Schema is captured by the pipeline; we don't need to keep our own copy.
  }

  /** Same-engine: destination schema IS the source schema. */
  translateSchema(source: InferredSchema): InferredSchema {
    return source;
  }

  /** Pass each row through verbatim. */
  mapRecord(rec: SourceRecord): DestRecord {
    return rec;
  }

  /** Identity mapping is lossless by definition — never any warnings. */
  drainWarnings(): SchemaWarning[] {
    return [];
  }
}
