import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ExternalLink, AlertTriangle, Skull, Activity, RefreshCw, BellRing,
  ChevronRight, Search, Lightbulb,
} from 'lucide-react'
import {
  api, type Connection, type MonitorSnapshot, type CurrentOp,
  type SlowQuery, type DbSize, type CollSize,
} from '../lib/api'
import { useConnectionsStore } from '../stores/connections.store'
import { SqlMonitor } from '../components/monitor/SqlMonitor'
import { useCurrentOps } from '../hooks/useCurrentOps'
import { formatBytes } from '../lib/utils'
import { GrafanaPanel } from '../components/monitor/GrafanaPanel'
import {
  Badge, Card, SectionLabel, StatusDot,
} from '../components/console/primitives'

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// stateBadgeColor removed — cluster header and replica topology now use
// console Badge primitives instead of inline class strings.

function durationColor(ms: number): string {
  if (ms < 1000) return 'text-emerald-500'
  if (ms < 5000) return 'text-amber-500'
  return 'text-destructive'
}

// ── Main page ────────────────────────────────────────────────────────────────

export function MonitorPage() {
  const { activeConnectionId } = useConnectionsStore()
  const grafanaUrl = import.meta.env.VITE_GRAFANA_URL ?? 'http://localhost:3003'

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  const conn = connections.find((c) => c.id === activeConnectionId)

  if (!activeConnectionId || !conn) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <p className="text-muted-foreground">Select a connection from the Connections page to view monitoring.</p>
      </div>
    )
  }

  // SQL connections get their own Monitor (Phase 2B). Mongo conns fall through
  // to MonitorBody which uses serverStatus / currentOp / replSetGetStatus.
  if (conn.dbType !== 'mongodb') {
    return <SqlMonitor conn={conn} grafanaUrl={grafanaUrl} />
  }

  return <MonitorBody connectionId={activeConnectionId} conn={conn} grafanaUrl={grafanaUrl} />
}

// ── Body (split out so hooks remount cleanly per connection) ────────────────

function MonitorBody({
  connectionId, conn, grafanaUrl,
}: { connectionId: string; conn: Connection; grafanaUrl: string }) {
  const { data: snapshot, isError, error } = useQuery({
    queryKey: ['monitor-snapshot', connectionId],
    queryFn: () => api.get<MonitorSnapshot>(`/api/connections/${connectionId}/monitor/snapshot`),
    refetchInterval: 5000,
  })

  // Grafana iframe vars
  const grafanaVars = useMemo(
    () => ({ connection_name: conn.name }),
    [conn.name],
  )

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
            Monitor
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-3)' }}>
            {conn.name} · {conn.topology}
          </p>
        </div>
        <a
          href={`${grafanaUrl}/d/mongodb-adv-vis?var-connection_name=${encodeURIComponent(conn.name)}`}
          target="_blank" rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', fontSize: 13,
            background: 'var(--surface)', color: 'var(--text-2)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            textDecoration: 'none', fontFamily: 'inherit',
          }}
        >
          <ExternalLink size={13}/>
          Open in Grafana
        </a>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {isError && (
        <Card style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
          <span style={{ color: 'var(--danger)', fontSize: 13 }}>
            Failed to load monitor snapshot: {(error as Error)?.message ?? 'unknown error'}
          </span>
        </Card>
      )}

      <ActiveAlertsBanner snapshot={snapshot} />

      {/* Section 1 — Cluster info bar */}
      <ClusterHeaderBar snapshot={snapshot} />

      {/* Section 2 — Grafana stat panels (4 across) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <GrafanaPanel panelId={1} height={200} vars={grafanaVars} />
        <GrafanaPanel panelId={2} height={200} vars={grafanaVars} />
        <GrafanaPanel panelId={3} height={200} vars={grafanaVars} />
        <GrafanaPanel panelId={4} height={200} vars={grafanaVars} />
      </div>

      {/* Section 3 — Grafana time-series charts (2 across) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GrafanaPanel panelId={5} height={300} vars={grafanaVars} />
        <GrafanaPanel panelId={6} height={300} vars={grafanaVars} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GrafanaPanel panelId={7} height={300} vars={grafanaVars} />
        <GrafanaPanel panelId={8} height={300} vars={grafanaVars} />
      </div>

      {/* Section 4 — Replica set topology */}
      <ReplicaTopology snapshot={snapshot} />

      {/* Section 5 — Current ops */}
      <CurrentOpsPanel connectionId={connectionId} />

      {/* Section 6 — Slow queries */}
      <SlowQueriesPanel connectionId={connectionId} />

      {/* Section 7 — DB & collection sizes */}
      <SizesPanel connectionId={connectionId} />

      {/* Section 8 — WT cache gauge (inline below sizes if relevant) */}
      {snapshot && snapshot.storageEngine === 'wiredTiger' && (
        <WiredTigerGauge snapshot={snapshot} />
      )}

      {/* Section 3 — Alert Rules */}
      <AlertRulesPanel connectionId={connectionId} />
      </div>
    </div>
  )
}

// ── Section 1: Cluster header bar ───────────────────────────────────────────

function ClusterHeaderBar({ snapshot }: { snapshot: MonitorSnapshot | undefined }) {
  if (!snapshot) {
    return <Card padded={false} style={{ padding: '14px 18px', height: 56, opacity: 0.5 }}><span/></Card>
  }
  const state = snapshot.replicaSet?.myStateName ?? 'STANDALONE'
  const tone: 'success' | 'accent' | 'warn' =
    state === 'PRIMARY' ? 'success'
    : state === 'SECONDARY' ? 'accent' : 'warn'
  return (
    <Card padded={false} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <Badge tone={tone} style={{ padding: '4px 9px' }}>
        <StatusDot tone={tone === 'success' ? 'success' : 'warn'}/> {state}
      </Badge>
      <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>
        v{snapshot.version || '?'}
      </span>
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{snapshot.storageEngine}</span>
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>Uptime: {fmtUptime(snapshot.uptime)}</span>
      {snapshot.activeAlerts > 0 && (
        <Badge tone="danger">
          {snapshot.activeAlerts} alert{snapshot.activeAlerts === 1 ? '' : 's'}
        </Badge>
      )}
      <span style={{
        marginLeft: 'auto',
        fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420,
      }}>
        {snapshot.host}
      </span>
    </Card>
  )
}

// ── Section 4: Replica set topology ─────────────────────────────────────────

function ReplicaTopology({ snapshot }: { snapshot: MonitorSnapshot | undefined }) {
  if (!snapshot?.replicaSet) return null
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <SectionLabel>Replica set</SectionLabel>
          <div style={{ marginTop: 4, fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
            {snapshot.replicaSet.name}
          </div>
        </div>
        <Badge tone="success">
          Healthy · {snapshot.replicaSet.members.filter(m => m.health === 1).length}/{snapshot.replicaSet.members.length}
        </Badge>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
        {snapshot.replicaSet.members.map((m) => {
          const isDown = m.health !== 1
          const accentVar =
            isDown ? 'var(--danger)'
            : m.stateName === 'PRIMARY' ? 'var(--success)'
            : m.stateName === 'SECONDARY' ? 'var(--accent)'
            : 'var(--text-3)'
          const tone: 'success' | 'accent' | 'danger' | 'neutral' =
            isDown ? 'danger'
            : m.stateName === 'PRIMARY' ? 'success'
            : m.stateName === 'SECONDARY' ? 'accent' : 'neutral'
          const lagColor = m.lagSeconds == null ? 'var(--text-3)'
            : m.lagSeconds > 30 ? 'var(--danger)'
            : m.lagSeconds > 10 ? 'var(--warn)' : 'var(--text-3)'
          return (
            <div key={m.name} style={{
              padding: '12px 14px',
              background: 'var(--rail)',
              border: '1px solid var(--border-soft)',
              borderLeft: `3px solid ${accentVar}`,
              borderRadius: 'var(--radius)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Badge tone={tone}>
                  {isDown && <AlertTriangle size={10}/>}
                  {m.stateName}
                </Badge>
                {m.self && (
                  <span style={{
                    fontSize: 10.5, color: 'var(--text-3)',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}>this node</span>
                )}
              </div>
              <div title={m.name} style={{
                fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-1)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{m.name}</div>
              <div style={{ marginTop: 8, display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-3)' }}>
                <span>health: {m.health === 1 ? '✓' : '✗'}</span>
                {m.lagSeconds !== null && m.stateName !== 'PRIMARY' && (
                  <span style={{ color: lagColor }}>lag: {m.lagSeconds.toFixed(1)}s</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Section 5: Current ops ──────────────────────────────────────────────────

function CurrentOpsPanel({ connectionId }: { connectionId: string }) {
  // Live updates via socket; fall back to REST poll on first load
  const liveOps = useCurrentOps(connectionId) as CurrentOp[]
  const { data: pollOps = [] } = useQuery({
    queryKey: ['currentops-rest', connectionId],
    queryFn: () => api.get<CurrentOp[]>(`/api/connections/${connectionId}/monitor/currentops`),
    refetchInterval: 5000,
    enabled: liveOps.length === 0,
  })
  const ops = (liveOps.length > 0 ? liveOps : pollOps) as CurrentOp[]

  const [nsFilter, setNsFilter] = useState('')
  const [minMs, setMinMs] = useState(0)
  const [opFilter, setOpFilter] = useState('')

  const filtered = ops.filter((o) => {
    if (nsFilter && !o.ns.toLowerCase().includes(nsFilter.toLowerCase())) return false
    if (opFilter && o.op !== opFilter) return false
    if (minMs > 0 && o.durationMs < minMs) return false
    return true
  })

  const [killing, setKilling] = useState<CurrentOp | null>(null)
  const qc = useQueryClient()
  const killMutation = useMutation({
    mutationFn: (opid: string | number) =>
      api.post(`/api/connections/${connectionId}/monitor/killop`, { opid }),
    onSuccess: () => {
      setKilling(null)
      qc.invalidateQueries({ queryKey: ['currentops-rest', connectionId] })
    },
  })

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-sm">Current Operations</h2>
          <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
            Live · {filtered.length} of {ops.length}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <input value={nsFilter} onChange={(e) => setNsFilter(e.target.value)} placeholder="Filter namespace"
            className="bg-input border border-border rounded px-2 py-1 w-32" />
          <input type="number" value={minMs || ''} onChange={(e) => setMinMs(Number(e.target.value) || 0)}
            placeholder="Min ms" className="bg-input border border-border rounded px-2 py-1 w-20" />
          <select value={opFilter} onChange={(e) => setOpFilter(e.target.value)}
            className="bg-input border border-border rounded px-2 py-1">
            <option value="">All ops</option>
            {['query','insert','update','remove','command','getmore'].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      </div>

      {ops.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active operations.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                <th className="text-left py-2 pr-4">Op ID</th>
                <th className="text-left py-2 pr-4">Type</th>
                <th className="text-left py-2 pr-4">Namespace</th>
                <th className="text-left py-2 pr-4">Op</th>
                <th className="text-left py-2 pr-4">Duration</th>
                <th className="text-left py-2 pr-4">Client</th>
                <th className="text-right py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((op) => (
                <tr key={String(op.opid)}
                    className={`border-b border-border/40 ${op.waitingForLock ? 'bg-amber-500/10' : 'hover:bg-secondary/20'}`}>
                  <td className="py-2 pr-4 font-mono text-xs">{String(op.opid)}</td>
                  <td className="py-2 pr-4 text-xs text-muted-foreground">{op.type}</td>
                  <td className="py-2 pr-4 text-xs truncate max-w-[200px]" title={op.ns}>{op.ns || '—'}</td>
                  <td className="py-2 pr-4"><span className="bg-secondary px-1.5 py-0.5 rounded text-xs">{op.op}</span></td>
                  <td className={`py-2 pr-4 text-xs font-mono ${durationColor(op.durationMs)}`}>
                    {op.durationMs < 1000 ? `${op.durationMs.toFixed(0)}ms` : `${(op.durationMs/1000).toFixed(1)}s`}
                  </td>
                  <td className="py-2 pr-4 text-xs text-muted-foreground truncate max-w-[160px]">{op.client || op.desc || '—'}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => setKilling(op)} className="text-destructive hover:text-destructive/80" title="Kill operation">
                      <Skull className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {killing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
            <h3 className="font-semibold mb-2">Kill operation</h3>
            <p className="text-sm text-muted-foreground mb-1">
              Kill operation <span className="font-mono">{String(killing.opid)}</span> on <span className="font-mono">{killing.ns || '—'}</span>?
            </p>
            <p className="text-xs text-destructive mb-4">This cannot be undone.</p>
            {killMutation.isError && (
              <p className="text-xs text-destructive mb-2">{(killMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setKilling(null)}
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-secondary">Cancel</button>
              <button onClick={() => killMutation.mutate(killing.opid)}
                disabled={killMutation.isPending}
                className="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
                {killMutation.isPending ? 'Killing…' : 'Kill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Section 6: Slow queries ─────────────────────────────────────────────────

function SlowQueriesPanel({ connectionId }: { connectionId: string }) {
  const [threshold, setThreshold] = useState(100)
  const [profilingDb, setProfilingDb] = useState('')
  const [inspecting, setInspecting] = useState<SlowQuery | null>(null)
  const qc = useQueryClient()

  const { data: queries = [] } = useQuery({
    queryKey: ['slowqueries', connectionId, threshold],
    queryFn: () => api.get<SlowQuery[]>(`/api/connections/${connectionId}/monitor/slowqueries?thresholdMs=${threshold}`),
    refetchInterval: 10_000,
  })

  const enableProfilingMutation = useMutation({
    mutationFn: (db: string) =>
      api.post(`/api/connections/${connectionId}/monitor/profiling`, { db, slowMs: threshold }),
    onSuccess: () => {
      setProfilingDb('')
      qc.invalidateQueries({ queryKey: ['slowqueries', connectionId] })
    },
  })

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-sm">Slow Queries</h2>
          <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
            &gt; {threshold}ms
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">Threshold:</label>
          <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}
            className="bg-input border border-border rounded px-2 py-1 w-20" />
          <input value={profilingDb} onChange={(e) => setProfilingDb(e.target.value)} placeholder="db to enable profiling"
            className="bg-input border border-border rounded px-2 py-1 w-44" />
          <button onClick={() => profilingDb && enableProfilingMutation.mutate(profilingDb)}
            disabled={!profilingDb || enableProfilingMutation.isPending}
            className="px-2 py-1 rounded border border-border hover:border-primary/50 disabled:opacity-50">
            Enable Profiling
          </button>
        </div>
      </div>

      {queries.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No slow queries above {threshold}ms.
          <p className="text-xs mt-1">
            Tip: profiling must be enabled on each database. Use the input above to enable it (level 1, slowms = threshold).
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                <th className="text-left py-2 pr-4">When</th>
                <th className="text-left py-2 pr-4">Namespace</th>
                <th className="text-left py-2 pr-4">Op</th>
                <th className="text-left py-2 pr-4">Duration</th>
                <th className="text-left py-2 pr-4">Keys</th>
                <th className="text-left py-2 pr-4">Docs Ex.</th>
                <th className="text-left py-2 pr-4">Returned</th>
                <th className="text-left py-2 pr-4">Plan</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {queries.map((q, i) => {
                const rowCls = q.durationMs > 500 ? 'bg-destructive/5'
                  : q.durationMs > 100 ? 'bg-amber-500/5' : ''
                return (
                  <tr key={i} className={`border-b border-border/40 hover:bg-secondary/20 ${rowCls}`}>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{q.ts ? new Date(q.ts).toLocaleTimeString() : '—'}</td>
                    <td className="py-2 pr-4 text-xs truncate max-w-[180px]" title={q.ns}>{q.ns}</td>
                    <td className="py-2 pr-4"><span className="bg-secondary px-1.5 py-0.5 rounded text-xs">{q.op}</span></td>
                    <td className={`py-2 pr-4 text-xs font-mono ${durationColor(q.durationMs)}`}>{q.durationMs}ms</td>
                    <td className="py-2 pr-4 text-xs">{q.keysExamined}</td>
                    <td className="py-2 pr-4 text-xs">{q.docsExamined}</td>
                    <td className="py-2 pr-4 text-xs">{q.docsReturned}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground truncate max-w-[120px]" title={q.planSummary}>{q.planSummary || '—'}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => setInspecting(q)}
                        className="text-primary hover:underline text-xs">Inspect</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {inspecting && <SlowQueryInspector query={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  )
}

function suggestIndex(query: Record<string, unknown>): string[] {
  // Pull a filter doc out of common command shapes
  const filter = (query.filter ?? query.query ?? query.q ?? {}) as Record<string, unknown>
  const fields = Object.keys(filter).filter((k) => !k.startsWith('$'))
  if (fields.length === 0) return []
  const collection =
    (query.find ?? query.update ?? query.delete ?? query.aggregate ?? 'collection') as string
  return fields.map((f) => `db.${collection}.createIndex({ ${f}: 1 })`)
}

function SlowQueryInspector({ query, onClose }: { query: SlowQuery; onClose: () => void }) {
  const suggestions = suggestIndex(query.query)
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="w-full max-w-2xl bg-card border-l border-border flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="font-semibold">Slow Query · {query.ns}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <Stat label="Duration">{query.durationMs}ms</Stat>
            <Stat label="Keys examined">{query.keysExamined}</Stat>
            <Stat label="Docs examined">{query.docsExamined}</Stat>
            <Stat label="Docs returned">{query.docsReturned}</Stat>
            <Stat label="Op">{query.op}</Stat>
            <Stat label="Plan">{query.planSummary || '—'}</Stat>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Query / Command</p>
            <pre className="bg-black/40 text-xs font-mono p-3 rounded border border-border overflow-x-auto whitespace-pre-wrap max-h-72">
              {JSON.stringify(query.query, null, 2)}
            </pre>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Suggest index</p>
            </div>
            {suggestions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No straightforward index suggestion (empty filter or only $ operators).</p>
            ) : (
              <div className="space-y-1">
                {suggestions.map((s, i) => (
                  <pre key={i} className="bg-black/40 text-xs font-mono p-2 rounded border border-border">{s}</pre>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-secondary/20 rounded p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm">{children}</p>
    </div>
  )
}

// ── Section 7: Database & Collection sizes ──────────────────────────────────

function SizesPanel({ connectionId }: { connectionId: string }) {
  const [tab, setTab] = useState<'dbs' | 'colls'>('dbs')
  const [selectedDb, setSelectedDb] = useState<string>('')
  const [sortBy, setSortBy] = useState<string>('dataSize')

  const { data: dbs = [], refetch: refetchDbs, isFetching } = useQuery({
    queryKey: ['dbsizes', connectionId],
    queryFn: () => api.get<DbSize[]>(`/api/connections/${connectionId}/monitor/dbsizes`),
    refetchInterval: 60_000,
  })

  // Auto-pick first db once loaded
  useEffect(() => {
    if (!selectedDb && dbs.length > 0) setSelectedDb(dbs[0].db)
  }, [dbs, selectedDb])

  const { data: colls = [], refetch: refetchColls } = useQuery({
    queryKey: ['collsizes', connectionId, selectedDb],
    queryFn: () => api.get<CollSize[]>(`/api/connections/${connectionId}/monitor/collsizes?db=${encodeURIComponent(selectedDb)}`),
    enabled: !!selectedDb && tab === 'colls',
    refetchInterval: 60_000,
  })

  const sortedDbs = useMemo(() => {
    return [...dbs].sort((a, b) => {
      const av = (a as unknown as Record<string, number>)[sortBy] ?? 0
      const bv = (b as unknown as Record<string, number>)[sortBy] ?? 0
      return bv - av
    })
  }, [dbs, sortBy])

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1 border-b border-border">
          {(['dbs', 'colls'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
              {t === 'dbs' ? 'Databases' : 'Collections'}
            </button>
          ))}
        </div>
        <button onClick={() => tab === 'dbs' ? refetchDbs() : refetchColls()}
          className="p-1.5 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-primary">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {tab === 'dbs' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                <SortableTh field="db" sortBy={sortBy} setSortBy={setSortBy}>Database</SortableTh>
                <SortableTh field="collections" sortBy={sortBy} setSortBy={setSortBy}>Collections</SortableTh>
                <SortableTh field="objects" sortBy={sortBy} setSortBy={setSortBy}>Documents</SortableTh>
                <SortableTh field="dataSize" sortBy={sortBy} setSortBy={setSortBy}>Data Size</SortableTh>
                <SortableTh field="indexSize" sortBy={sortBy} setSortBy={setSortBy}>Index Size</SortableTh>
                <SortableTh field="storageSize" sortBy={sortBy} setSortBy={setSortBy}>Total</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sortedDbs.map((d) => (
                <tr key={d.db} className="border-b border-border/40 hover:bg-secondary/20 cursor-pointer"
                    onClick={() => { setSelectedDb(d.db); setTab('colls') }}>
                  <td className="py-2 pr-4 font-medium">{d.db}</td>
                  <td className="py-2 pr-4 text-xs">{d.collections}</td>
                  <td className="py-2 pr-4 text-xs">{d.objects.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-xs">{formatBytes(d.dataSize)}</td>
                  <td className="py-2 pr-4 text-xs">{formatBytes(d.indexSize)}</td>
                  <td className="py-2 pr-4 text-xs">{formatBytes(d.storageSize)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'colls' && (
        <>
          <div className="mb-3 flex items-center gap-2 text-xs">
            <label className="text-muted-foreground">Database:</label>
            <select value={selectedDb} onChange={(e) => setSelectedDb(e.target.value)}
              className="bg-input border border-border rounded px-2 py-1">
              {dbs.map((d) => <option key={d.db} value={d.db}>{d.db}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  <th className="text-left py-2 pr-4">Collection</th>
                  <th className="text-left py-2 pr-4">Documents</th>
                  <th className="text-left py-2 pr-4">Avg Doc</th>
                  <th className="text-left py-2 pr-4">Data Size</th>
                  <th className="text-left py-2 pr-4">Index Size</th>
                  <th className="text-left py-2 pr-4">Indexes</th>
                </tr>
              </thead>
              <tbody>
                {colls.map((c) => (
                  <tr key={c.name} className="border-b border-border/40 hover:bg-secondary/20">
                    <td className="py-2 pr-4 font-medium">{c.name}</td>
                    <td className="py-2 pr-4 text-xs">{c.count.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-xs">{formatBytes(c.avgObjSize)}</td>
                    <td className="py-2 pr-4 text-xs">{formatBytes(c.size)}</td>
                    <td className="py-2 pr-4 text-xs">{formatBytes(c.totalIndexSize)}</td>
                    <td className="py-2 pr-4 text-xs">{c.nindexes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function SortableTh({
  field, sortBy, setSortBy, children,
}: { field: string; sortBy: string; setSortBy: (f: string) => void; children: React.ReactNode }) {
  const active = sortBy === field
  return (
    <th className="text-left py-2 pr-4">
      <button onClick={() => setSortBy(field)}
        className={`flex items-center gap-1 ${active ? 'text-primary' : ''}`}>
        {children}{active && <ChevronRight className="h-3 w-3 rotate-90" />}
      </button>
    </th>
  )
}

// ── Section 8: WiredTiger cache gauge ───────────────────────────────────────

function WiredTigerGauge({ snapshot }: { snapshot: MonitorSnapshot }) {
  const pct = snapshot.wtCacheMaxMB > 0
    ? (snapshot.wtCacheUsedMB / snapshot.wtCacheMaxMB) * 100
    : 0
  const color = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#10b981'

  // SVG semicircular gauge (radius 80, viewbox 200x110)
  const r = 80, cx = 100, cy = 100
  const startAngle = Math.PI                // 180°
  const endAngle   = Math.PI * (1 - pct/100) // sweep counter-clockwise
  const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle)
  const x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle)
  const largeArc = pct > 50 ? 1 : 0

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col md:flex-row items-center gap-6">
      <svg viewBox="0 0 200 120" width={220} height={130}>
        {/* background arc */}
        <path d={`M ${20} 100 A ${r} ${r} 0 0 1 ${180} 100`}
              fill="none" stroke="#27272a" strokeWidth={16} strokeLinecap="round" />
        {/* filled arc */}
        {pct > 0 && (
          <path d={`M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`}
                fill="none" stroke={color} strokeWidth={16} strokeLinecap="round" />
        )}
        <text x="100" y="90" textAnchor="middle" fontSize="22" fill="#fafafa" fontWeight="bold">
          {pct.toFixed(0)}%
        </text>
      </svg>
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">WiredTiger Cache</p>
        <p className="text-sm">
          <span className="font-mono">{snapshot.wtCacheUsedMB.toFixed(0)}</span> MB used of{' '}
          <span className="font-mono">{snapshot.wtCacheMaxMB.toFixed(0)}</span> MB configured
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Hit ratio: <span className="text-emerald-500">{snapshot.wtCacheHitRatio.toFixed(1)}%</span>
        </p>
      </div>
    </div>
  )
}

// ── Section 3 (PRD): Alert rules ────────────────────────────────────────────

// ── Alert metric catalog ─────────────────────────────────────────────────────

import type { AlertMetric, AlertCondition, AlertRule, AlertEvent } from '../lib/api'
import { Plus, Pause as PauseIcon, Play as PlayIcon, Edit2, Mail, Webhook, X } from 'lucide-react'

// Metric entries are tagged with the engines they make sense for. The alert
// evaluator returns null for engine-incompatible metrics (e.g. memResident on
// PG), so rules created with them would silently never fire — better to hide
// them at creation time.
type MetricEntry = { value: AlertMetric; label: string; engines: Array<'mongodb' | 'postgres' | 'mysql'> }

const ALL_ALERT_METRICS: MetricEntry[] = [
  { value: 'currentConnections',   label: 'Current Connections',     engines: ['mongodb', 'postgres', 'mysql'] },
  { value: 'availableConnections', label: 'Available Connections',   engines: ['mongodb', 'postgres', 'mysql'] },
  { value: 'memResident',          label: 'Resident Memory (MB)',    engines: ['mongodb'] },
  { value: 'memVirtual',           label: 'Virtual Memory (MB)',     engines: ['mongodb'] },
  { value: 'opsPerSecTotal',       label: 'Operations/sec (total)',  engines: ['mongodb', 'postgres', 'mysql'] },
  { value: 'replicationLag',       label: 'Replication Lag (seconds)', engines: ['mongodb', 'postgres', 'mysql'] },
  { value: 'wtCachePercent',       label: 'Cache Hit (%)',           engines: ['mongodb', 'postgres', 'mysql'] },
  { value: 'networkBytesIn',       label: 'Network In (bytes/s)',    engines: ['mongodb'] },
  { value: 'networkBytesOut',      label: 'Network Out (bytes/s)',   engines: ['mongodb'] },
]

// Default Mongo list preserves prior behaviour when consumers don't pass an engine.
const ALERT_METRICS: Array<{ value: AlertMetric; label: string }> = ALL_ALERT_METRICS.map(
  ({ value, label }) => ({ value, label }),
)

function metricsForEngine(engine?: string): Array<{ value: AlertMetric; label: string }> {
  if (!engine) return ALERT_METRICS
  return ALL_ALERT_METRICS
    .filter((m) => m.engines.includes(engine as 'mongodb' | 'postgres' | 'mysql'))
    .map(({ value, label }) => ({ value, label }))
}

const CONDITION_OPTIONS: Array<{ value: AlertCondition; label: string }> = [
  { value: 'gt',  label: '> greater than' },
  { value: 'lt',  label: '< less than' },
  { value: 'gte', label: '≥ greater or equal' },
  { value: 'lte', label: '≤ less or equal' },
]

function metricLabel(m: AlertMetric): string {
  return ALERT_METRICS.find((x) => x.value === m)?.label ?? m
}
function conditionSymbol(c: AlertCondition): string {
  return c === 'gt' ? '>' : c === 'lt' ? '<' : c === 'gte' ? '≥' : '≤'
}
function fmtDurationLive(start: string): string {
  const ms = Date.now() - new Date(start).getTime()
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s}s`
}
function relativeAgo(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

// ── 6A: Active alerts banner ────────────────────────────────────────────────

function ActiveAlertsBanner({ snapshot }: { snapshot: MonitorSnapshot | undefined }) {
  if (!snapshot || snapshot.activeAlerts === 0) return null
  const scrollToAlerts = () => {
    document.getElementById('alert-rules')?.scrollIntoView({ behavior: 'smooth' })
  }
  return (
    <div className="bg-destructive text-destructive-foreground rounded p-3 flex items-center gap-3 text-sm shadow-lg">
      <span className="relative flex h-3 w-3">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
        <span className="relative inline-flex rounded-full h-3 w-3 bg-white" />
      </span>
      <span className="font-semibold">
        {snapshot.activeAlerts} alert{snapshot.activeAlerts === 1 ? '' : 's'} firing on this connection
      </span>
      <button onClick={scrollToAlerts}
        className="ml-auto text-xs font-semibold underline hover:no-underline">
        View All ↓
      </button>
    </div>
  )
}

// ── 6B: Alert Rules Panel ────────────────────────────────────────────────────

export function AlertRulesPanel({ connectionId, engine }: { connectionId: string; engine?: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<AlertRule | null>(null)

  const { data: rules = [] } = useQuery({
    queryKey: ['alert-rules', connectionId],
    queryFn: () => api.get<AlertRule[]>(`/api/alerts/rules?connectionId=${connectionId}`),
    refetchInterval: 5_000,
  })

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<AlertRule> }) =>
      api.patch(`/api/alerts/rules/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules', connectionId] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/alerts/rules/${id}`),
    onSuccess: () => {
      setDeleteConfirm(null)
      qc.invalidateQueries({ queryKey: ['alert-rules', connectionId] })
    },
  })

  const showDefaults = rules.length === 0

  return (
    <div id="alert-rules" className="bg-card border border-border rounded-lg">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-4 text-sm font-semibold">
        <span className="flex items-center gap-2">
          <BellRing className="h-4 w-4 text-primary" />
          Alert Rules
          <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">{rules.length}</span>
        </span>
        <div className="flex items-center gap-2">
          <button onClick={(e) => { e.stopPropagation(); setCreating(true) }}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="h-3 w-3" /> New Rule
          </button>
          <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-border p-4 space-y-4">
          {showDefaults && (
            <DefaultRuleSuggestions connectionId={connectionId} onCreated={() =>
              qc.invalidateQueries({ queryKey: ['alert-rules', connectionId] })
            } />
          )}

          {rules.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Name</th>
                    <th className="text-left py-2 pr-3">Condition</th>
                    <th className="text-left py-2 pr-3">Firing For</th>
                    <th className="text-left py-2 pr-3">Last Event</th>
                    <th className="text-left py-2 pr-3">Notify</th>
                    <th className="text-right py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <RuleRow key={r.id} rule={r}
                      onEdit={() => setEditing(r)}
                      onTogglePause={() => patchMutation.mutate({ id: r.id, data: { enabled: !r.enabled } })}
                      onDelete={() => setDeleteConfirm(r)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <AlertEventsHistory connectionId={connectionId} />
        </div>
      )}

      {creating && (
        <RuleFormModal connectionId={connectionId} engine={engine} onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            qc.invalidateQueries({ queryKey: ['alert-rules', connectionId] })
          }} />
      )}
      {editing && (
        <RuleFormModal connectionId={connectionId} engine={engine} editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            qc.invalidateQueries({ queryKey: ['alert-rules', connectionId] })
          }} />
      )}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
            <h3 className="font-semibold mb-2">Delete Alert Rule</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Delete <strong>{deleteConfirm.name}</strong>? All its event history will also be removed.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-secondary">Cancel</button>
              <button onClick={() => deleteMutation.mutate(deleteConfirm.id)}
                disabled={deleteMutation.isPending}
                className="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 6C: Rule row with live-updating "firing for" duration ────────────────────

function RuleRow({
  rule, onEdit, onTogglePause, onDelete,
}: {
  rule: AlertRule
  onEdit: () => void
  onTogglePause: () => void
  onDelete: () => void
}) {
  // Tick every second while firing so "Firing For" updates live
  const [, setTick] = useState(0)
  useEffect(() => {
    if (rule.status !== 'firing' || !rule.firingStartedAt) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [rule.status, rule.firingStartedAt])

  const statusBadge = rule.status === 'firing' ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-destructive">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
      </span>
      Firing
    </span>
  ) : !rule.enabled ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-2 w-2 rounded-full bg-muted-foreground" /> Paused
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500">
      <span className="h-2 w-2 rounded-full bg-emerald-500" /> OK
    </span>
  )

  return (
    <tr className="border-b border-border/40 hover:bg-secondary/20">
      <td className="py-2 pr-3">{statusBadge}</td>
      <td className="py-2 pr-3 font-medium">{rule.name}</td>
      <td className="py-2 pr-3 text-xs">
        <span className="text-muted-foreground">{metricLabel(rule.metric)}</span>{' '}
        <span className="font-mono">{conditionSymbol(rule.condition)} {rule.threshold}</span>
        <span className="text-muted-foreground"> for {rule.durationMinutes}m</span>
      </td>
      <td className="py-2 pr-3 text-xs font-mono">
        {rule.status === 'firing' && rule.firingStartedAt
          ? <span className="text-destructive">{fmtDurationLive(rule.firingStartedAt)}</span>
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {relativeAgo(rule.latestEvent?.firedAt ?? null)}
      </td>
      <td className="py-2 pr-3 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          {rule.notifyEmail && <Mail className="h-3 w-3" />}
          {rule.notifyWebhook && <Webhook className="h-3 w-3" />}
          {!rule.notifyEmail && !rule.notifyWebhook && <span>None</span>}
        </div>
      </td>
      <td className="py-2 text-right">
        <div className="inline-flex items-center gap-1">
          <button onClick={onEdit} title="Edit"
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={onTogglePause} title={rule.enabled ? 'Pause' : 'Resume'}
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
            {rule.enabled ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
          </button>
          <button onClick={onDelete} title="Delete"
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-destructive">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── 6B: Create / Edit modal ──────────────────────────────────────────────────

function RuleFormModal({
  connectionId, editing, onClose, onSaved, engine,
}: {
  connectionId: string
  editing?: AlertRule
  onClose: () => void
  onSaved: () => void
  engine?: string
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [metric, setMetric] = useState<AlertMetric>(editing?.metric ?? 'currentConnections')
  const availableMetrics = metricsForEngine(engine)
  const [condition, setCondition] = useState<AlertCondition>(editing?.condition ?? 'gt')
  const [threshold, setThreshold] = useState<number>(editing?.threshold ?? 100)
  const [durationMinutes, setDurationMinutes] = useState<number>(editing?.durationMinutes ?? 1)
  const [notifyEmail, setNotifyEmail] = useState(editing?.notifyEmail ?? '')
  const [notifyWebhook, setNotifyWebhook] = useState(editing?.notifyWebhook ?? '')

  const save = useMutation({
    mutationFn: () => editing
      ? api.patch(`/api/alerts/rules/${editing.id}`, {
          name, threshold, condition, durationMinutes,
          notifyEmail: notifyEmail || null,
          notifyWebhook: notifyWebhook || null,
        })
      : api.post('/api/alerts/rules', {
          name, connectionId, metric, condition, threshold, durationMinutes,
          notifyEmail: notifyEmail || undefined,
          notifyWebhook: notifyWebhook || undefined,
        }),
    onSuccess: onSaved,
  })

  const preview = `Alert when ${metricLabel(metric)} ${conditionSymbol(condition)} ${threshold} for ${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`
  const canSave = name.trim().length > 0 && threshold > 0 && durationMinutes > 0

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-5 max-w-lg w-full mx-4 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{editing ? 'Edit Alert Rule' : 'Create Alert Rule'}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="space-y-2 text-sm">
          <div>
            <label className="text-xs text-muted-foreground">Rule name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. High connection count"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Metric</label>
            <select value={metric} onChange={(e) => setMetric(e.target.value as AlertMetric)}
              disabled={!!editing}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm disabled:opacity-50">
              {availableMetrics.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {editing && <p className="text-[10px] text-muted-foreground mt-0.5">Metric cannot be changed — create a new rule instead.</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Condition</label>
              <select value={condition} onChange={(e) => setCondition(e.target.value as AlertCondition)}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
                {CONDITION_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Threshold</label>
              <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Fire after condition holds for (minutes)</label>
            <input type="number" min={1} value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>

          <div className="border-t border-border pt-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Notifications (optional)</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                <input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)}
                  placeholder="ops@example.com"
                  className="flex-1 bg-input border border-border rounded px-3 py-1.5 text-sm" />
              </div>
              <div className="flex items-center gap-2">
                <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                <input type="url" value={notifyWebhook} onChange={(e) => setNotifyWebhook(e.target.value)}
                  placeholder="https://hooks.slack.com/..."
                  className="flex-1 bg-input border border-border rounded px-3 py-1.5 text-sm" />
              </div>
            </div>
          </div>

          <div className="bg-secondary/30 rounded p-2 text-xs">
            <span className="text-muted-foreground">Preview: </span>
            <span className="font-medium">{preview}</span>
          </div>
        </div>

        {save.isError && <p className="text-xs text-destructive">{(save.error as Error).message}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!canSave || save.isPending}
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : (editing ? 'Save Changes' : 'Create Rule')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 7: Default rule suggestions ──────────────────────────────────────────────

const DEFAULT_SUGGESTIONS: Array<{
  icon: string; name: string; metric: AlertMetric; condition: AlertCondition;
  threshold: number; durationMinutes: number; description: string;
}> = [
  { icon: '⚡', name: 'High Connections', metric: 'currentConnections', condition: 'gt', threshold: 450, durationMinutes: 2, description: 'connections > 450 for 2 minutes' },
  { icon: '🧠', name: 'Memory Pressure',  metric: 'memResident',        condition: 'gt', threshold: 1024, durationMinutes: 5, description: 'resident > 1024 MB for 5 minutes' },
  { icon: '🔄', name: 'Replication Lag',  metric: 'replicationLag',     condition: 'gt', threshold: 10,   durationMinutes: 1, description: 'lag > 10 seconds for 1 minute' },
  { icon: '💾', name: 'Cache Pressure',   metric: 'wtCachePercent',     condition: 'gt', threshold: 85,   durationMinutes: 3, description: 'wtCache > 85% for 3 minutes' },
]

function DefaultRuleSuggestions({
  connectionId, onCreated,
}: { connectionId: string; onCreated: () => void }) {
  const create = useMutation({
    mutationFn: (s: typeof DEFAULT_SUGGESTIONS[number]) =>
      api.post('/api/alerts/rules', {
        connectionId,
        name: s.name,
        metric: s.metric,
        condition: s.condition,
        threshold: s.threshold,
        durationMinutes: s.durationMinutes,
      }),
    onSuccess: onCreated,
  })

  return (
    <div className="border border-dashed border-border rounded p-3 bg-secondary/10">
      <p className="text-xs text-muted-foreground mb-3">
        No alert rules configured. Start with our recommended defaults:
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {DEFAULT_SUGGESTIONS.map((s) => (
          <div key={s.name} className="bg-card border border-border rounded p-3 flex items-start gap-3">
            <span className="text-xl leading-none">{s.icon}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">{s.name}</p>
              <p className="text-xs text-muted-foreground mb-2">{s.description}</p>
              <button onClick={() => create.mutate(s)}
                disabled={create.isPending}
                className="text-xs px-2 py-1 rounded border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-50">
                + Add This Rule
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 6D: Event history (collapsible, paginated) ───────────────────────────────

function AlertEventsHistory({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(20)
  const [acking, setAcking] = useState<AlertEvent | null>(null)

  const { data: events = [] } = useQuery({
    queryKey: ['alert-events', connectionId, limit],
    queryFn: () => api.get<AlertEvent[]>(`/api/alerts/events?connectionId=${connectionId}&limit=${limit}`),
    refetchInterval: 10_000,
    enabled: open,
  })

  return (
    <div className="border border-border rounded">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-3 text-sm">
        <span className="flex items-center gap-2">
          <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          Event History
        </span>
      </button>
      {open && (
        <div className="border-t border-border p-3 overflow-x-auto">
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No events yet.</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-left py-2 pr-3">Rule</th>
                    <th className="text-left py-2 pr-3">Metric</th>
                    <th className="text-left py-2 pr-3">Value</th>
                    <th className="text-left py-2 pr-3">Threshold</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Fired</th>
                    <th className="text-left py-2 pr-3">Duration</th>
                    <th className="text-right py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <EventRow key={e.id} event={e} onAck={() => setAcking(e)} />
                  ))}
                </tbody>
              </table>
              {events.length >= limit && (
                <button onClick={() => setLimit(limit + 20)}
                  className="text-xs text-primary hover:underline mt-2">Load more</button>
              )}
            </>
          )}
        </div>
      )}

      {acking && (
        <AcknowledgeModal event={acking} onClose={() => setAcking(null)}
          onAcked={() => {
            setAcking(null)
            qc.invalidateQueries({ queryKey: ['alert-events', connectionId] })
            qc.invalidateQueries({ queryKey: ['alert-rules', connectionId] })
          }} />
      )}
    </div>
  )
}

function EventRow({ event, onAck }: { event: AlertEvent; onAck: () => void }) {
  const statusBadge = event.status === 'firing'
    ? <span className="text-xs font-semibold text-destructive">🔴 Firing</span>
    : event.status === 'resolved'
    ? <span className="text-xs text-emerald-500">✅ Resolved</span>
    : <span className="text-xs text-muted-foreground">✓ Acknowledged</span>

  const duration = event.resolvedAt
    ? Math.round((new Date(event.resolvedAt).getTime() - new Date(event.firedAt).getTime()) / 1000)
    : null
  const durationStr = duration === null
    ? (event.status === 'firing' ? 'ongoing' : '—')
    : duration < 60 ? `${duration}s` : `${Math.round(duration / 60)}m`

  return (
    <tr className="border-b border-border/40 hover:bg-secondary/20">
      <td className="py-2 pr-3 text-xs">{event.rule?.name ?? '—'}</td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">{metricLabel(event.metric)}</td>
      <td className="py-2 pr-3 text-xs font-mono">{event.value.toFixed(2)}</td>
      <td className="py-2 pr-3 text-xs font-mono">{conditionSymbol(event.condition)} {event.threshold}</td>
      <td className="py-2 pr-3">{statusBadge}</td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">{relativeAgo(event.firedAt)}</td>
      <td className="py-2 pr-3 text-xs">{durationStr}</td>
      <td className="py-2 text-right">
        {event.status === 'firing' ? (
          <button onClick={onAck} className="text-xs text-primary hover:underline">Acknowledge</button>
        ) : event.status === 'acknowledged' && event.note ? (
          <span className="text-xs text-muted-foreground italic truncate max-w-[160px] inline-block" title={event.note}>{event.note}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  )
}

function AcknowledgeModal({
  event, onClose, onAcked,
}: { event: AlertEvent; onClose: () => void; onAcked: () => void }) {
  const [note, setNote] = useState('')
  const ack = useMutation({
    mutationFn: () => api.post(`/api/alerts/events/${event.id}/acknowledge`, { note: note || undefined }),
    onSuccess: onAcked,
  })
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full mx-4 shadow-xl space-y-3">
        <h3 className="font-semibold">Acknowledge Alert</h3>
        <p className="text-xs text-muted-foreground">
          {event.rule?.name ?? 'Rule'} fired at {new Date(event.firedAt).toLocaleString()}.
        </p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (e.g. 'Investigating — known traffic spike')"
          rows={3}
          className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
        {ack.isError && <p className="text-xs text-destructive">{(ack.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-border hover:bg-secondary">Cancel</button>
          <button onClick={() => ack.mutate()} disabled={ack.isPending}
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {ack.isPending ? 'Saving…' : 'Confirm Acknowledge'}
          </button>
        </div>
      </div>
    </div>
  )
}
