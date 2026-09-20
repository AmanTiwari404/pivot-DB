import { useState, type CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, Database as DatabaseIcon, Table as TableIcon,
  Bookmark, Download,
} from 'lucide-react'
import { api, type Connection, type SavedQuery } from '../lib/api'
import { useConnectionsStore } from '../stores/connections.store'
import { SchemaGraph } from '../components/explore/SchemaGraph'
import { AggregationEditor } from '../components/explore/AggregationEditor'
import { SqlExplorer } from '../components/explore/SqlExplorer'
import { formatBytes } from '../lib/utils'

interface DbInfo { name: string }
interface CollInfo { name: string }

type ExploreTab = 'documents' | 'schema' | 'aggregate'

export function ExplorePage() {
  const { activeConnectionId } = useConnectionsStore()
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  const [selectedColl, setSelectedColl] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ExploreTab>('documents')
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('{}')
  const [page, setPage] = useState(0)
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table')
  const PAGE_SIZE = 50

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })
  const conn = connections.find((c) => c.id === activeConnectionId)

  const { data: databases = [] } = useQuery({
    queryKey: ['databases', activeConnectionId],
    queryFn: () => api.get<DbInfo[]>(`/api/connections/${activeConnectionId}/explore/databases`),
    enabled: !!activeConnectionId,
  })

  const { data: collections = [] } = useQuery({
    queryKey: ['collections', activeConnectionId, selectedDb],
    queryFn: () => api.get<CollInfo[]>(`/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections`),
    enabled: !!(activeConnectionId && selectedDb),
  })

  const { data: queryResult, isLoading: queryLoading } = useQuery({
    queryKey: ['query', activeConnectionId, selectedDb, selectedColl, filter, page],
    queryFn: async () => {
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(filter) } catch { parsed = {} }
      return api.post<{ docs: Record<string, unknown>[]; total: number }>(
        `/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections/${selectedColl}/query`,
        { filter: parsed, limit: PAGE_SIZE, skip: page * PAGE_SIZE }
      )
    },
    enabled: !!(activeConnectionId && selectedDb && selectedColl && activeTab === 'documents'),
  })

  const { data: collStats } = useQuery({
    queryKey: ['collstats', activeConnectionId, selectedDb, selectedColl],
    queryFn: () => api.get<Record<string, unknown>>(
      `/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections/${selectedColl}/stats`
    ),
    enabled: !!(activeConnectionId && selectedDb && selectedColl),
  })

  const { data: indexes = [] } = useQuery({
    queryKey: ['indexes', activeConnectionId, selectedDb, selectedColl],
    queryFn: () => api.get<Record<string, unknown>[]>(
      `/api/connections/${activeConnectionId}/explore/databases/${selectedDb}/collections/${selectedColl}/indexes`
    ),
    enabled: !!(activeConnectionId && selectedDb && selectedColl),
  })

  const { data: savedQueries = [] } = useQuery({
    queryKey: ['saved-queries', activeConnectionId],
    queryFn: () => api.get<SavedQuery[]>(`/api/connections/${activeConnectionId}/explore/saved-queries`),
    enabled: !!activeConnectionId,
  })

  const qc = useQueryClient()
  const saveQueryMutation = useMutation({
    mutationFn: (name: string) => api.post(
      `/api/connections/${activeConnectionId}/explore/saved-queries`,
      { name, database: selectedDb, collection: selectedColl, query: JSON.parse(filter || '{}'), isPipeline: false }
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-queries', activeConnectionId] }),
  })

  const toggleDb = (dbName: string) => {
    const next = new Set(expandedDbs)
    if (next.has(dbName)) next.delete(dbName)
    else next.add(dbName)
    setExpandedDbs(next)
    setSelectedDb(dbName)
  }

  const handleExport = () => {
    if (!activeConnectionId || !selectedDb || !selectedColl) return
    api.post<{ id: string }>('/api/export', {
      connectionId: activeConnectionId, database: selectedDb,
      collection: selectedColl, query: {}, format: 'json', options: {},
    }).then(() => alert('Export job queued. Check Move → Export for download link.'))
  }

  if (!activeConnectionId || !conn) {
    return (
      <div style={{
        padding: 24, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', height: '100%',
        color: 'var(--text-3)', fontSize: 13,
      }}>
        Select a connection from the Connections page to explore.
      </div>
    )
  }

  // SQL connections get their own dedicated explorer (tables + paginated rows).
  // The Mongo body below stays untouched so its existing query/schema/aggregate
  // tabs continue to work — we just dispatch on dbType here.
  if (conn.dbType !== 'mongodb') {
    return <SqlExplorer conn={conn} />
  }

  const docs = queryResult?.docs ?? []
  const total = queryResult?.total ?? 0
  const columns = docs.length > 0 ? Object.keys(docs[0]).filter((k) => k !== '_id').slice(0, 10) : []
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Left tree */}
      <aside style={{
        width: 224, flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border-soft)',
        overflow: 'auto',
      }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border-soft)' }}>
          <p style={{
            margin: 0, fontSize: 10.5, fontWeight: 600, color: 'var(--text-3)',
            textTransform: 'uppercase', letterSpacing: '0.08em',
          }}>{conn.name}</p>
        </div>
        <div style={{ padding: '8px 0' }}>
          {databases.map((db) => (
            <div key={db.name}>
              <button onClick={() => toggleDb(db.name)} style={dbRowStyle}>
                {expandedDbs.has(db.name)
                  ? <ChevronDown size={12} style={{ color: 'var(--text-3)' }}/>
                  : <ChevronRight size={12} style={{ color: 'var(--text-3)' }}/>}
                <DatabaseIcon size={13} style={{ color: 'var(--text-3)' }}/>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{db.name}</span>
              </button>
              {expandedDbs.has(db.name) && db.name === selectedDb && collections.map((coll) => {
                const on = coll.name === selectedColl
                return (
                  <button
                    key={coll.name}
                    onClick={() => { setSelectedColl(coll.name); setPage(0); setActiveTab('documents') }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 12px 6px 32px',
                      border: 'none', cursor: 'pointer', textAlign: 'left',
                      background: on ? 'var(--accent-soft)' : 'transparent',
                      color: on ? 'var(--accent)' : 'var(--text-3)',
                      fontFamily: 'inherit', fontSize: 13,
                    }}
                  >
                    <TableIcon size={12} style={{ flexShrink: 0 }}/>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{coll.name}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* Center */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedColl && selectedDb ? (
          <>
            {/* Toolbar */}
            <div style={{
              borderBottom: '1px solid var(--border-soft)',
              padding: '8px 16px',
              display: 'flex', alignItems: 'center', gap: 16,
              background: 'var(--surface)', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['documents', 'schema', 'aggregate'] as const).map((tab) => {
                  const on = activeTab === tab
                  return (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      style={{
                        padding: '6px 12px', fontSize: 12, borderRadius: 'var(--radius)',
                        textTransform: 'capitalize', cursor: 'pointer', fontFamily: 'inherit',
                        border: 'none',
                        background: on ? 'var(--accent-soft)' : 'transparent',
                        color: on ? 'var(--accent)' : 'var(--text-3)',
                      }}
                    >{tab}</button>
                  )
                })}
              </div>
              <div style={{ flex: 1 }}/>
              {activeTab === 'documents' && (
                <>
                  <button
                    onClick={() => setViewMode(v => v === 'table' ? 'json' : 'table')}
                    style={toolbarBtnStyle}
                  >
                    {viewMode === 'table' ? 'JSON View' : 'Table View'}
                  </button>
                  <button
                    onClick={() => { const name = prompt('Query name:'); if (name) saveQueryMutation.mutate(name) }}
                    style={{ ...toolbarBtnStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Bookmark size={12}/> Save
                  </button>
                  <button
                    onClick={handleExport}
                    style={{ ...toolbarBtnStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Download size={12}/> Export
                  </button>
                </>
              )}
            </div>

            {/* Filter bar */}
            {activeTab === 'documents' && (
              <div style={{
                borderBottom: '1px solid var(--border-soft)',
                padding: '8px 16px',
                background: 'var(--surface)', flexShrink: 0,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Filter:</span>
                <input
                  value={filter}
                  onChange={(e) => { setFilter(e.target.value); setPage(0) }}
                  placeholder="{}"
                  style={{
                    flex: 1, background: 'var(--surface)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                    padding: '4px 8px', fontSize: 12,
                    fontFamily: 'var(--font-mono)', color: 'var(--text-1)',
                    outline: 'none',
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {total.toLocaleString()} docs
                </span>
              </div>
            )}

            {/* Content */}
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--surface)' }}>
              {activeTab === 'documents' && (
                <>
                  {queryLoading && (
                    <div style={{ padding: 16, fontSize: 13, color: 'var(--text-3)' }}>Loading…</div>
                  )}
                  {!queryLoading && viewMode === 'table' && (
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                        <tr style={{ borderBottom: '1px solid var(--border-soft)' }}>
                          {['_id', ...columns].map((col) => (
                            <th key={col} style={{
                              textAlign: 'left', padding: '8px 12px',
                              color: 'var(--text-3)', fontWeight: 500,
                            }}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {docs.map((doc, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                            {['_id', ...columns].map((col) => (
                              <td key={col} style={{
                                padding: '8px 12px',
                                fontFamily: 'var(--font-mono)',
                                maxWidth: 200,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                color: 'var(--text-1)',
                              }}>
                                {JSON.stringify(doc[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {!queryLoading && viewMode === 'json' && (
                    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {docs.map((doc, i) => (
                        <pre key={i} style={{
                          margin: 0, fontSize: 12, padding: 12,
                          background: 'var(--rail)', borderRadius: 'var(--radius)',
                          overflowX: 'auto', fontFamily: 'var(--font-mono)',
                          color: 'var(--text-1)',
                        }}>
                          {JSON.stringify(doc, null, 2)}
                        </pre>
                      ))}
                    </div>
                  )}
                  {totalPages > 1 && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      padding: '12px 0', borderTop: '1px solid var(--border-soft)',
                    }}>
                      <button
                        disabled={page === 0}
                        onClick={() => setPage(page - 1)}
                        style={paginateBtnStyle(page === 0)}
                      >Previous</button>
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        Page {page + 1} of {totalPages}
                      </span>
                      <button
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage(page + 1)}
                        style={paginateBtnStyle(page >= totalPages - 1)}
                      >Next</button>
                    </div>
                  )}
                  {savedQueries.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border-soft)', padding: 16 }}>
                      <p style={{
                        margin: '0 0 8px', fontSize: 10.5, fontWeight: 600,
                        color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em',
                      }}>SAVED QUERIES</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {savedQueries.map((q) => (
                          <button
                            key={q.id}
                            onClick={() => setFilter(JSON.stringify(q.query))}
                            style={{
                              width: '100%', textAlign: 'left',
                              fontSize: 12, padding: '6px 8px',
                              borderRadius: 'var(--radius)',
                              border: 'none', background: 'transparent',
                              cursor: 'pointer', fontFamily: 'inherit',
                              color: 'var(--text-1)',
                            }}
                          >{q.name}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {activeTab === 'schema' && (
                <SchemaGraph
                  connectionId={activeConnectionId}
                  database={selectedDb}
                  collection={selectedColl}
                />
              )}
              {activeTab === 'aggregate' && (
                <AggregationEditor
                  connectionId={activeConnectionId}
                  database={selectedDb}
                  collection={selectedColl}
                />
              )}
            </div>
          </>
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-3)', fontSize: 13,
          }}>
            Select a collection from the tree on the left.
          </div>
        )}
      </div>

      {/* Right stats panel */}
      {selectedColl && selectedDb && (
        <aside style={{
          width: 288, flexShrink: 0,
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border-soft)',
          overflow: 'auto',
        }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border-soft)' }}>
            <h3 style={{
              margin: 0, fontSize: 13, fontWeight: 600,
              color: 'var(--text-1)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{selectedDb}.{selectedColl}</h3>
          </div>
          {collStats && (
            <div style={{ padding: 16, borderBottom: '1px solid var(--border-soft)' }}>
              <p style={{
                margin: '0 0 12px', fontSize: 10.5, fontWeight: 600,
                color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>Stats</p>
              {[
                ['Documents', (collStats['count'] as number)?.toLocaleString()],
                ['Size',      collStats['size']       != null ? formatBytes(collStats['size'] as number) : '—'],
                ['Avg Doc',   collStats['avgObjSize'] != null ? formatBytes(collStats['avgObjSize'] as number) : '—'],
                ['Indexes',   String(collStats['nindexes'] ?? '—')],
              ].map(([label, value]) => (
                <div key={label} style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 12, padding: '4px 0',
                }}>
                  <span style={{ color: 'var(--text-3)' }}>{label}</span>
                  <span style={{ color: 'var(--text-1)', fontWeight: 500 }}>{value}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ padding: 16 }}>
            <p style={{
              margin: '0 0 12px', fontSize: 10.5, fontWeight: 600,
              color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em',
            }}>Indexes</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {indexes.map((idx, i) => (
                <div key={i} style={{
                  background: 'var(--rail)', borderRadius: 'var(--radius)',
                  border: '1px solid var(--border-soft)',
                  padding: 8, fontSize: 12,
                }}>
                  <p style={{ margin: 0, fontWeight: 500, color: 'var(--text-1)' }}>
                    {String(idx['name'])}
                  </p>
                  <p style={{
                    margin: '2px 0 0', color: 'var(--text-3)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {JSON.stringify(idx['key'])}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

const dbRowStyle: CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
  padding: '6px 12px',
  border: 'none', background: 'transparent', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 13, color: 'var(--text-1)',
  textAlign: 'left',
}

const toolbarBtnStyle: CSSProperties = {
  fontSize: 12, padding: '4px 8px',
  background: 'var(--surface)', color: 'var(--text-3)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  cursor: 'pointer', fontFamily: 'inherit',
}

function paginateBtnStyle(disabled: boolean): CSSProperties {
  return {
    fontSize: 12, padding: '4px 12px',
    background: 'var(--surface)', color: 'var(--text-1)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    fontFamily: 'inherit',
  }
}
