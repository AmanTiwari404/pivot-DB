import type { CanonicalType, InferredColumn, InferredSchema } from '../types.js';

/**
 * Generate MySQL `CREATE TABLE` statements from an InferredSchema.
 *
 * Notes:
 *   - Identifiers quoted with backticks (MySQL style).
 *   - ObjectId → VARCHAR(24) (hex string).
 *   - nested objects / arrays → JSON (MySQL 5.7+).
 *   - 'mixed' / 'unknown' → TEXT.
 *   - Charset / collation forced to utf8mb4 to survive emoji and 4-byte chars.
 */
export function buildMysqlCreateTable(
  schema: InferredSchema,
  opts: { dbName?: string; tableName?: string; ifNotExists?: boolean; drop?: boolean } = {},
): string[] {
  const dbName    = opts.dbName ?? schema.namespace.database;
  const tableName = mysqlIdent(opts.tableName ?? schema.namespace.name);
  const qualified = '`' + dbName + '`.' + '`' + tableName + '`';
  const ifNot     = opts.ifNotExists ? 'IF NOT EXISTS ' : '';

  const lines: string[] = [];

  if (opts.drop) {
    lines.push(`DROP TABLE IF EXISTS ${qualified};`);
  }

  const seen     = new Set<string>();
  const colDefs: string[] = [];
  const pkCols:  string[] = [];

  for (const col of schema.columns) {
    let cname = mysqlIdent(col.name);
    while (seen.has(cname)) cname = cname + '_';
    seen.add(cname);

    const sqlType   = canonicalToMysqlType(col.type);
    const nullClause = col.nullable ? '' : ' NOT NULL';
    // MySQL requires AUTO_INCREMENT on an integer-typed key column. Only emit
    // when the source actually flagged it; Mongo sources never do.
    const aiClause =
      col.autoIncrement && (col.type === 'int' || col.type === 'long')
        ? ' AUTO_INCREMENT'
        : '';
    colDefs.push('  `' + cname + '` ' + sqlType + nullClause + aiClause);

    if (col.primaryKey) pkCols.push('`' + cname + '`');
  }

  let sql = `CREATE TABLE ${ifNot}${qualified} (\n${colDefs.join(',\n')}`;
  if (pkCols.length > 0) {
    sql += `,\n  PRIMARY KEY (${pkCols.join(', ')})`;
  }
  sql += '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;';
  lines.push(sql);

  return lines;
}

/** Ordered list of column names for INSERT, mirroring the schema order. */
export function mysqlColumnList(schema: InferredSchema): string[] {
  const seen = new Set<string>();
  return schema.columns.map((col) => {
    let name = mysqlIdent(col.name);
    while (seen.has(name)) name = name + '_';
    seen.add(name);
    return name;
  });
}

function mysqlIdent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 64);
}

function canonicalToMysqlType(t: CanonicalType): string {
  switch (t) {
    case 'string':    return 'TEXT';
    case 'int':       return 'INT';
    case 'long':      return 'BIGINT';
    case 'float':     return 'FLOAT';
    case 'double':    return 'DOUBLE';
    case 'decimal':   return 'DECIMAL(65,10)';
    case 'boolean':   return 'TINYINT(1)';
    case 'date':      return 'DATE';
    case 'timestamp': return 'DATETIME(6)';
    case 'time':      return 'TIME';
    case 'binary':    return 'LONGBLOB';
    case 'uuid':      return 'VARCHAR(36)';
    case 'objectid':  return 'VARCHAR(24)';
    case 'json':      return 'JSON';
    case 'jsonb':     return 'JSON';
    case 'array':     return 'JSON';
    case 'mixed':     return 'TEXT';
    case 'unknown':   return 'TEXT';
    case 'null':      return 'TEXT';
    default: {
      const _: never = t;
      return 'TEXT';
    }
  }
}
