import { Db } from 'mongodb';

interface FieldStats {
  count: number;
  nullCount: number;
  types: Set<string>;
  distinctValues: Set<string>;
  min?: number;
  max?: number;
  avg?: number;
}

function getBsonType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'string') return 'string';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  if (Buffer.isBuffer(value)) return 'binData';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('_bsontype' in v) return String(v._bsontype).toLowerCase();
    return 'object';
  }
  return 'unknown';
}

function walkDocument(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  map: Map<string, FieldStats>,
): void {
  if (depth > 5) return;
  for (const [key, value] of Object.entries(obj)) {
    if (key === '_id' && depth === 0) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const btype = getBsonType(value);
    if (!map.has(path)) {
      map.set(path, { count: 0, nullCount: 0, types: new Set(), distinctValues: new Set() });
    }
    const stats = map.get(path)!;
    stats.count++;
    if (value === null || value === undefined) {
      stats.nullCount++;
      continue;
    }
    stats.types.add(btype);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (stats.distinctValues.size < 1000) stats.distinctValues.add(String(value));
    }
    if (btype === 'object' && !Array.isArray(value)) {
      walkDocument(value as Record<string, unknown>, path, depth + 1, map);
    }
  }
}

export async function sampleSchema(db: Db, collectionName: string, sampleSize = 1000) {
  const coll = db.collection(collectionName);
  const docs = await coll.aggregate([{ $sample: { size: sampleSize } }]).toArray();
  const total = await coll.estimatedDocumentCount();
  const fieldMap: Map<string, FieldStats> = new Map();

  for (const doc of docs) {
    walkDocument(doc as Record<string, unknown>, '', 0, fieldMap);
  }

  for (const [path, stats] of fieldMap.entries()) {
    if (stats.types.has('number') || stats.types.has('int') || stats.types.has('double')) {
      const agg = await coll.aggregate([
        { $sample: { size: 10000 } },
        { $group: { _id: null, min: { $min: `$${path}` }, max: { $max: `$${path}` }, avg: { $avg: `$${path}` } } },
      ]).toArray();
      if (agg[0]) {
        stats.min = agg[0].min as number;
        stats.max = agg[0].max as number;
        stats.avg = agg[0].avg as number;
      }
    }
  }

  const fields = Array.from(fieldMap.entries()).map(([path, stats]) => ({
    path,
    types: Array.from(stats.types),
    isMixedType: stats.types.size > 1,
    presencePercent: docs.length > 0 ? (stats.count / docs.length) * 100 : 0,
    nullRate: docs.length > 0 ? (stats.nullCount / docs.length) * 100 : 0,
    cardinality: stats.distinctValues.size,
    min: stats.min,
    max: stats.max,
    avg: stats.avg,
  }));

  return { fields, sampleSize: docs.length, totalDocuments: total };
}
