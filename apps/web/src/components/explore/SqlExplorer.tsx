import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, Database as DatabaseIcon, Table as TableIcon,
  KeyRound, Link2, Hash, ChevronLeft, ChevronsRight,
} from 'lucide-react'
import { api, type Connection, type DbType } from '../../lib/api'

// ─────────────────────────────────────────────────────────────────────────────
// SqlExplorer — Phase 2A
//
// Left tree:   schemas/databases → tables
// Right body:  tabs (Rows / Schema)
//   • Rows  — paginated table view with offset/limit
//   • Schema — column list with type, nullable, PK, FK target
// ─────────────────────────────────────────────────────────────────────────────

interface DiscoveredColumn {
  name: string
  type: string
  nullable: boolean
  primaryKey?: boolean
  references?: string
}
interface DiscoveredNamespace {
  database: string
  name: string
  approxCount?: number
  columns: DiscoveredColumn[]
}
interface RowPage {
  rows: Array<Record<string, unknown>>
  total: number
  totalExact: boolean
}

const PAGE_SIZE = 50

export function SqlExplorer({ conn }: { conn: Connection }) {
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'rows' | 'schema'>('rows')
  const [offset, setOffset] = useState(0)

  // List of schemas (PG) or databases (MySQL) visible to this credential.
  const { data: dbList = [] } = useQuery({
    queryKey: ['sql-databases', conn.id],
    queryFn: () =>
      api.get<{ dbType: DbType; databases: string[] }>(`/api/connections/${conn.id}/databases`)
        .then((r) => r.databases),
  })

  // Tables for the currently-expanded database (we only fetch the one in view).
  const { data: schemaForDb = [] } = useQuery<DiscoveredNamespace[]>({
    queryKey: ['sql-schema', conn.id, selectedDb],
    queryFn: () =>
      api.get<{ dbType: DbType; namespaces: DiscoveredNamespace[] }>(
        `/api/connections/${conn.id}/schema?database=${encodeURIComponent(selectedDb!)}`,
      ).then((r) => r.namespaces),
    enabled: !!selectedDb,
  })

  const tablesByDb: Record<string, DiscoveredNamespace[]> = {}
  if (selectedDb) tablesByDb[selectedDb] = schemaForDb

  // Rows page for the selected table.
  const { data: rowPage, isLoading: rowsLoading } = useQuery<RowPage>({
    queryKey: ['sql-rows', conn.id, selectedDb, selectedTable, offset],
    queryFn: () =>
      api.get<RowPage>(
        `/api/connections/${conn.id}/sql/tables/${encodeURIComponent(selectedDb!)}/${encodeURIComponent(selectedTable!)}/rows?limit=${PAGE_SIZE}&offset=${offset}`,
      ),
    enabled: !!(selectedDb && selectedTable && tab === 'rows'),
  })

  const selectedTableSchema = schemaForDb.find((t) => t.name === selectedTable)

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Left tree */}
      <aside style={{
        width: 240, flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border-soft)',
        overflow: 'auto',
      }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border-soft)' }}>
          <p style={{
            margin: 0, fontSize: 10.5, fontWeight: 600, color: 'var(--text-3)',
            textTransform: 'uppercase', letterSpacing: '0.08em',
          }}>{conn.name}</p>
          <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--text-4)' }}>
            {conn.dbType === 'postgres' ? 'PostgreSQL' : 'MySQL'}
          </p>
        </div>
        <div style={{ padding: '8px 0' }}>
          {dbList.map((db) => {
            const open = expandedDbs.has(db)
            return (
              <div key={db}>
                <button
                  onClick={() => {
                    setExpandedDbs((prev) => {
                      const next = new Set(prev)
                      if (next.has(db)) next.delete(db); else next.add(db)
                      return next
                    })
                    setSelectedDb(db)
                  }}
                  style={treeRow}
                >
                  {open
                    ? <ChevronDown size={12} style={{ color: 'var(--text-3)' }} />
                    : <ChevronRight size={12} style={{ color: 'var(--text-3)' }} />}
                  <DatabaseIcon size={13} style={{ color: 'var(--text-3)' }} />
                  <span style={truncate}>{db}</span>
                </button>
                {open && db === selectedDb && (tablesByDb[db] ?? []).map((t) => {
                  const active = t.name === selectedTable
                  return (
                    <button
                      key={t.name}
                      onClick={() => { setSelectedTable(t.name); setOffset(0); setTab('rows') }}
                      style={{
                        ...treeRow,
                        paddingLeft: 32,
                        background: active ? 'var(--accent-soft)' : 'transparent',
                        color: active ? 'var(--accent)' : 'var(--text-2)',
                        fontWeight: active ? 500 : 400,
                      }}
                    >
                      <TableIcon size={12} />
                      <span style={truncate}>{t.name}</span>
                      {t.approxCount !== undefined && (
                        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-4)' }}>
                          {t.approxCount}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </aside>

      {/* Body */}
      <main style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {!selectedTable && (
          <div style={emptyState}>
            <TableIcon size={32} style={{ color: 'var(--text-4)' }} />
            <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
              {dbList.length === 0
                ? 'Loading databases…'
                : 'Select a table from the tree on the left.'}
            </p>
          </div>
        )}

        {selectedTable && selectedDb && (
          <>
            {/* Header */}
            <div style={{
              padding: '14px 20px',
              borderBottom: '1px solid var(--border-soft)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                {selectedDb}.{selectedTable}
              </h2>
              {selectedTableSchema?.approxCount !== undefined && (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {selectedTableSchema.approxCount.toLocaleString()} rows
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <TabBtn label="Rows"   active={tab === 'rows'}   onClick={() => setTab('rows')} />
                <TabBtn label="Schema" active={tab === 'schema'} onClick={() => setTab('schema')} />
              </div>
            </div>

            {/* Tab content */}
            {tab === 'rows' && (
              <RowsView
                page={rowPage}
                loading={rowsLoading}
                columns={selectedTableSchema?.columns ?? []}
                offset={offset}
                pageSize={PAGE_SIZE}
                onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                onNext={() => setOffset(offset + PAGE_SIZE)}
              />
            )}
            {tab === 'schema' && selectedTableSchema && (
              <SchemaView schema={selectedTableSchema} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

// ── Sub-views ───────────────────────────────────────────────────────────────

function RowsView({ page, loading, columns, offset, pageSize, onPrev, onNext }: {
  page?: RowPage
  loading: boolean
  columns: DiscoveredColumn[]
  offset: number
  pageSize: number
  onPrev: () => void
  onNext: () => void
}) {
  if (loading && !page) {
    return <div style={emptyState}><span style={{ color: 'var(--text-3)' }}>Loading…</span></div>
  }
  if (!page || page.rows.length === 0) {
    return <div style={emptyState}><span style={{ color: 'var(--text-3)' }}>No rows.</span></div>
  }

  // Use the SCHEMA's column order (declared order) over Object.keys() of the
  // first row, because the latter is at the mercy of the driver's iteration
  // order and doesn't match what the user sees in psql.
  const cols = columns.length > 0
    ? columns.map((c) => c.name)
    : Object.keys(page.rows[0])

  const upperShown = Math.min(offset + page.rows.length, page.total)

  return (
    <>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
            <tr>
              {cols.map((c) => (
                <th key={c} style={th}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border-soft)' }}>
                {cols.map((c) => (
                  <td key={c} style={td}><CellValue value={row[c]} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{
        padding: '8px 20px',
        borderTop: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', gap: 10,
        fontSize: 12, color: 'var(--text-3)',
      }}>
        <span>
          Showing {offset + 1}–{upperShown} of {page.total.toLocaleString()}{page.totalExact ? '' : ' (est.)'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={onPrev} disabled={offset === 0} style={pagerBtn(offset === 0)}>
            <ChevronLeft size={13} /> Prev
          </button>
          <button onClick={onNext} disabled={offset + pageSize >= page.total} style={pagerBtn(offset + pageSize >= page.total)}>
            Next <ChevronsRight size={13} />
          </button>
        </div>
      </div>
    </>
  )
}

function SchemaView({ schema }: { schema: DiscoveredNamespace }) {
  return (
    <div style={{ padding: 20, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={th}>Column</th>
            <th style={th}>Type</th>
            <th style={th}>Nullable</th>
            <th style={th}>Key</th>
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((c) => (
            <tr key={c.name} style={{ borderTop: '1px solid var(--border-soft)' }}>
              <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{c.name}</td>
              <td style={td}>
                <span style={{
                  padding: '2px 6px', borderRadius: 4, fontSize: 11,
                  background: 'var(--rail)', color: 'var(--text-2)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {c.type}
                </span>
              </td>
              <td style={{ ...td, color: 'var(--text-3)' }}>{c.nullable ? 'yes' : 'no'}</td>
              <td style={td}>
                {c.primaryKey && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', fontSize: 12 }}>
                    <KeyRound size={11} /> PK
                  </span>
                )}
                {c.references && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-3)', fontSize: 12 }}>
                    <Link2 size={11} /> {c.references}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Renderers + styles ──────────────────────────────────────────────────────

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>NULL</span>
  }
  if (typeof value === 'boolean') {
    return <span style={{ color: 'var(--text-2)' }}>{value ? 'true' : 'false'}</span>
  }
  if (typeof value === 'number') {
    return <span style={{ fontFamily: 'var(--font-mono)' }}>{value}</span>
  }
  if (value instanceof Date) {
    return <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{value.toISOString()}</span>
  }
  if (Array.isArray(value) || typeof value === 'object') {
    // pg returns json/jsonb already parsed; arrays come as arrays.
    const s = JSON.stringify(value)
    return (
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 12,
        color: 'var(--accent)', maxWidth: 400, display: 'inline-block',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} title={s}>
        {s}
      </span>
    )
  }
  // string + everything else
  const s = String(value)
  return (
    <span style={{
      maxWidth: 400, display: 'inline-block',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }} title={s}>
      {s}
    </span>
  )
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 12,
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-3)',
        border: 'none', borderRadius: 'var(--radius-sm)',
        cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  )
}

const treeRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  width: '100%', padding: '6px 12px',
  background: 'transparent', color: 'var(--text-2)',
  border: 'none', cursor: 'pointer', textAlign: 'left',
  fontSize: 13, fontFamily: 'inherit',
}
const truncate: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const emptyState: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 12,
  color: 'var(--text-3)', fontSize: 13,
}
const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px',
  fontSize: 11, fontWeight: 600,
  color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em',
  borderBottom: '1px solid var(--border)',
}
const td: React.CSSProperties = {
  padding: '7px 12px',
  color: 'var(--text-1)', verticalAlign: 'top',
}
function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    padding: '4px 9px', fontSize: 12,
    background: 'var(--surface)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    fontFamily: 'inherit',
  }
}

// Hash icon is imported but referenced lazily below — keeps tree-shaking happy.
void Hash
