import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import { api, type Connection, type ExportJob } from '../lib/api'

const BASE = import.meta.env.VITE_API_URL ?? ''

async function downloadExport(jobId: string, format: string, exportType?: string) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${BASE}/api/export/${jobId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Download failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // Database exports are tar.gz archives; single-collection exports use the format extension
  const ext = exportType === 'database' ? 'tar.gz' : format
  a.download = `export-${jobId}.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}
import { JobStatusBadge } from '../components/shared/JobStatusBadge'
import { formatDate } from '../lib/utils'

export function MovePage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">Move</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Export tables and collections to CSV, JSON, or archive files.
        For continuous replication between databases, use the <span className="font-medium text-foreground">Sync</span> page.
      </p>
      <ExportTab />
    </div>
  )
}

function ExportTab() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Connection[]>('/api/connections') })
  const [exportMode, setExportMode] = useState<'collection' | 'database'>('collection')
  const [connId, setConnId] = useState('')
  const [db, setDb] = useState('')
  const [coll, setColl] = useState('')
  const [excludeColls, setExcludeColls] = useState<string[]>([])
  const [format, setFormat] = useState<'csv' | 'json'>('json')

  const selectedConn = connections.find((c) => c.id === connId)
  const isSql = selectedConn?.dbType === 'postgres' || selectedConn?.dbType === 'mysql'

  // Multi-engine endpoints — work for Mongo, PG, and MySQL.
  // For SQL: returned `databases` are schemas (PG) or databases (MySQL);
  // returned namespaces are tables. We keep the variable names `databases`
  // and `colls` for parity with the Mongo path; the UI labels rename them.
  const { data: databases = [] } = useQuery({
    queryKey: ['databases', connId],
    queryFn: () => api.get<{ dbType: string; databases: string[] }>(`/api/connections/${connId}/databases`)
      .then((r) => r.databases.map((name) => ({ name }))),
    enabled: !!connId,
  })
  const { data: colls = [] } = useQuery({
    queryKey: ['collections', connId, db],
    queryFn: async () => {
      if (isSql) {
        // SQL: discoverSchema returns namespaces with column metadata; we only
        // need names here.
        const r = await api.get<{ dbType: string; namespaces: Array<{ name: string }> }>(
          `/api/connections/${connId}/schema?database=${encodeURIComponent(db)}`,
        )
        return r.namespaces.map((n) => ({ name: n.name }))
      }
      return api.get<{ name: string }[]>(`/api/connections/${connId}/explore/databases/${db}/collections`)
    },
    enabled: !!(connId && db),
  })

  // Engine-aware copy
  const itemLabel    = isSql ? 'Table'  : 'Collection'
  const itemsLabel   = isSql ? 'Tables' : 'Collections'
  const containerLbl = !selectedConn ? 'Database'
    : selectedConn.dbType === 'postgres' ? 'Schema'
    : 'Database'
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ['export-jobs', connId],
    queryFn: () => api.get<ExportJob[]>(`/api/export?connectionId=${connId}`),
    enabled: !!connId,
    refetchInterval: 5000,
  })

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/export', {
      connectionId: connId,
      exportType: exportMode,
      database: db,
      ...(exportMode === 'collection' ? { collection: coll } : {}),
      query: {},
      format,
      options: exportMode === 'database' ? { excludeCollections: excludeColls } : {},
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['export-jobs', connId] }) },
  })

  const canExport = exportMode === 'collection'
    ? !!(connId && db && coll)
    : !!(connId && db)

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">New Export</h2>

        {/* Export mode toggle — labels switch to Table/Schema for SQL conns */}
        <div className="flex gap-4 mb-4">
          {(['collection', 'database'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" value={m} checked={exportMode === m} onChange={() => { setExportMode(m); setColl(''); setExcludeColls([]) }} />
              {m === 'collection'
                ? (isSql ? 'Single Table'   : 'Single Collection')
                : (isSql ? `Entire ${containerLbl}` : 'Entire Database')}
            </label>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Connection</label>
            <select value={connId} onChange={(e) => { setConnId(e.target.value); setDb(''); setColl('') }}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              <option value="">Select…</option>
              {/* All engines supported as of Phase 3A. Show dbType inline so
                  the user knows which engine each connection points at. */}
              {connections.map((c) =>
                <option key={c.id} value={c.id}>{c.name} ({c.dbType})</option>
              )}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{containerLbl}</label>
            <select value={db} onChange={(e) => { setDb(e.target.value); setColl('') }}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" disabled={!connId}>
              <option value="">Select…</option>
              {databases.map((d) => <option key={d.name}>{d.name}</option>)}
            </select>
          </div>

          {exportMode === 'collection' ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{itemLabel}</label>
              <select value={coll} onChange={(e) => setColl(e.target.value)}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm" disabled={!db}>
                <option value="">Select…</option>
                {colls.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Exclude {itemsLabel} (optional)</label>
              <div className="bg-input border border-border rounded p-2 max-h-32 overflow-y-auto">
                {colls.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{db ? 'Loading…' : 'Select a database first'}</p>
                ) : colls.map((c) => (
                  <label key={c.name} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                    <input type="checkbox" checked={excludeColls.includes(c.name)}
                      onChange={(e) => setExcludeColls(prev => e.target.checked ? [...prev, c.name] : prev.filter(x => x !== c.name))} />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Format</label>
            <div className="flex gap-4 mt-2">
              {(['json', 'csv'] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" value={f} checked={format === f} onChange={() => setFormat(f)} />
                  {f.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={!canExport || createMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {createMutation.isPending ? 'Creating…' : 'Export'}
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Export History</h2>
            <button onClick={() => refetch()} className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-4 w-4" /></button>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase">
              <th className="text-left py-2">Type</th>
              <th className="text-left py-2">Target</th>
              <th className="text-left py-2">Format</th>
              <th className="text-left py-2">Status</th>
              <th className="text-left py-2">Created</th>
              <th className="text-right py-2">Download</th>
            </tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border/30">
                  <td className="py-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${j.exportType === 'database' ? 'bg-blue-500/20 text-blue-400' : 'bg-secondary text-muted-foreground'}`}>
                      {j.exportType === 'database' ? 'Database' : 'Collection'}
                    </span>
                  </td>
                  <td className="py-2">{j.exportType === 'database' ? j.database : `${j.database}.${j.collection}`}</td>
                  <td className="py-2 uppercase text-xs">{j.format}</td>
                  <td className="py-2"><JobStatusBadge status={j.status} /></td>
                  <td className="py-2 text-xs text-muted-foreground">{formatDate(j.createdAt)}</td>
                  <td className="py-2 text-right">
                    {j.status === 'done' && (
                      <button
                        onClick={() => downloadExport(j.id, j.format, j.exportType)}
                        className="text-primary text-xs hover:underline"
                      >
                        Download
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
