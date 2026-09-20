import type { DbType } from './clients/index.js';

/**
 * Validate that a URI string matches the selected dbType.
 * Returns null on success, or a human-readable error message on failure.
 *
 * Catches the most common user mistake: pasting a Postgres URI into a
 * MongoDB slot (or vice-versa) and getting a cryptic driver error 10s later.
 */
export function validateUri(dbType: DbType, uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return 'URI is required';

  switch (dbType) {
    case 'mongodb':
      if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) {
        return 'MongoDB URI must start with "mongodb://" or "mongodb+srv://"';
      }
      return null;

    case 'postgres':
      if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
        return 'Postgres URI must start with "postgres://" or "postgresql://"';
      }
      return null;

    case 'mysql':
      if (!/^mysql:\/\//i.test(trimmed)) {
        return 'MySQL URI must start with "mysql://"';
      }
      return null;

    default: {
      const _exhaustive: never = dbType;
      return `Unsupported dbType: ${String(_exhaustive)}`;
    }
  }
}

/** True if the dbType is one we recognise. */
export function isValidDbType(s: unknown): s is DbType {
  return s === 'mongodb' || s === 'postgres' || s === 'mysql';
}
