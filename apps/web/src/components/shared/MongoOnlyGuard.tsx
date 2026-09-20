import { Database } from 'lucide-react'
import type { Connection } from '../../lib/api'

/**
 * Reusable empty-state shown on Mongo-only pages (Explore, Monitor, Move,
 * Protect) when the active connection is Postgres or MySQL. Phase 0 introduced
 * multi-engine connections; rebuilding these pages for SQL is post-Phase-1
 * work — until then, give the user a clear off-ramp.
 *
 * Usage:
 *   if (conn.dbType !== 'mongodb') return <MongoOnlyGuard conn={conn} feature="Monitor" />
 */
export function MongoOnlyGuard({
  conn,
  feature,
}: {
  conn: Connection
  feature: string
}) {
  const engineLabel =
    conn.dbType === 'postgres' ? 'PostgreSQL' :
    conn.dbType === 'mysql'    ? 'MySQL' :
                                  conn.dbType

  return (
    <div className="p-8 flex flex-col items-center justify-center h-full text-center gap-3">
      <Database className="h-9 w-9 text-muted-foreground" />
      <div>
        <h2 className="text-base font-semibold">
          {feature} doesn't support {engineLabel} yet
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-md">
          The {feature} page is built around MongoDB. For {engineLabel}, use a
          native client (psql, DBeaver, TablePlus) or use <b>Migrate</b> to copy
          this database into a MongoDB target.
        </p>
      </div>
      <div className="flex gap-2 mt-2">
        <a href="/connections"
          className="px-3 py-1.5 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
          Switch connection
        </a>
        <a href="/migrate"
          className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 font-medium">
          Open Migrate
        </a>
      </div>
    </div>
  )
}
