import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ExternalLink, AlertTriangle, Loader2,
} from 'lucide-react'
import { api, type Connection, type SqlMonitorSnapshot } from '../../lib/api'
import { formatBytes } from '../../lib/utils'
import { GrafanaPanel } from './GrafanaPanel'
import { Badge, Card, SectionLabel, StatusDot } from '../console/primitives'
import { AlertRulesPanel } from '../../pages/Monitor'

const POLL_MS = 5000

const GRAFANA_DASHBOARDS: Record<string, string> = {
  postgres: 'sqlmon-postgres',
  mysql:    'sqlmon-mysql',
}

export function SqlMonitor({ conn, grafanaUrl }: { conn: Connection; grafanaUrl: string }) {
  const { data, error, isLoading } = useQuery<SqlMonitorSnapshot>({
    queryKey: ['sql-monitor', conn.id],
    queryFn: () => api.get<SqlMonitorSnapshot>(`/api/connections/${conn.id}/sql/monitor/snapshot`),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  })

  const grafanaVars = useMemo(() => ({ connection_name: conn.name }), [conn.name])
  const dashUid = GRAFANA_DASHBOARDS[conn.dbType]
  const engineLabel = conn.dbType === 'postgres' ? 'PostgreSQL' : 'MySQL'

  if (isLoading && !data) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading monitor snapshot…
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive/30 rounded p-4 flex items-start gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
          <div>
            <p className="font-medium text-destructive">Couldn't load monitor data</p>
            <p className="text-muted-foreground mt-0.5">{(error as Error).message}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header — mirrors MongoDB MonitorBody header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
            Monitor
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-3)' }}>
            {conn.name}
            {data ? ` · ${engineLabel} v${data.version}` : ` · ${engineLabel}`}
            {data?.currentDatabase ? ` · ${data.currentDatabase}` : ''}
          </p>
        </div>
        {dashUid && (
          <a
            href={`${grafanaUrl}/d/${dashUid}?var-connection_name=${encodeURIComponent(conn.name)}`}
            target="_blank" rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', fontSize: 13,
              background: 'var(--surface)', color: 'var(--text-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              textDecoration: 'none', fontFamily: 'inherit',
            }}
          >
            <ExternalLink size={13} />
            Open in Grafana
          </a>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Cluster header bar — mirrors MongoDB ClusterHeaderBar */}
        {data && <SqlClusterBar data={data} engineLabel={engineLabel} />}

        {/* Stat panels — same 4-up layout as MongoDB monitor */}
        {dashUid && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <GrafanaPanel dashboardUid={dashUid} panelId={1} height={200} vars={grafanaVars} />
            <GrafanaPanel dashboardUid={dashUid} panelId={2} height={200} vars={grafanaVars} />
            <GrafanaPanel dashboardUid={dashUid} panelId={3} height={200} vars={grafanaVars} />
            <GrafanaPanel dashboardUid={dashUid} panelId={4} height={200} vars={grafanaVars} />
          </div>
        )}

        {/* Time-series — same 2×2 grid as MongoDB monitor */}
        {dashUid && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <GrafanaPanel dashboardUid={dashUid} panelId={5} height={300} vars={grafanaVars} />
              <GrafanaPanel dashboardUid={dashUid} panelId={6} height={300} vars={grafanaVars} />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <GrafanaPanel dashboardUid={dashUid} panelId={7} height={300} vars={grafanaVars} />
              <GrafanaPanel dashboardUid={dashUid} panelId={8} height={300} vars={grafanaVars} />
            </div>
          </>
        )}

        {/* Top tables */}
        {data && <TopTablesPanel data={data} />}

        {/* Active queries */}
        {data && <ActiveQueriesPanel data={data} />}

        {/* Alert rules — same UX as Mongo monitor. Metric dropdown is
            filtered to PG/MySQL-applicable options by the panel itself. */}
        <AlertRulesPanel connectionId={conn.id} engine={conn.dbType} />
      </div>
    </div>
  )
}

// ── Cluster header bar ────────────────────────────────────────────────────────

function SqlClusterBar({ data, engineLabel }: { data: SqlMonitorSnapshot; engineLabel: string }) {
  const isReplica = data.replication?.isReplica ?? false
  const role = isReplica ? 'REPLICA' : 'PRIMARY'
  const tone: 'success' | 'accent' = isReplica ? 'accent' : 'success'
  const uptimeStr = formatUptime(data.uptimeSeconds)

  return (
    <Card padded={false} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <Badge tone={tone} style={{ padding: '4px 9px' }}>
        <StatusDot tone={tone === 'success' ? 'success' : 'warn'} /> {role}
      </Badge>
      <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>
        {engineLabel} v{data.version}
      </span>
      {data.replication?.isReplica && data.replication.lagSeconds != null && (
        <span style={{ fontSize: 13, color: data.replication.lagSeconds > 10 ? 'var(--danger)' : 'var(--text-3)' }}>
          lag: {data.replication.lagSeconds}s
        </span>
      )}
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
        uptime {uptimeStr}
      </span>
      {data.currentDatabase && (
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {data.currentDatabase}
        </span>
      )}
    </Card>
  )
}

// ── Top tables ────────────────────────────────────────────────────────────────

function TopTablesPanel({ data }: { data: SqlMonitorSnapshot }) {
  return (
    <Card padded={false}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionLabel>Top tables by size</SectionLabel>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {data.topTables.length} shown
        </span>
      </div>
      {data.topTables.length === 0 ? (
        <p style={{ padding: '20px', fontSize: 13, color: 'var(--text-3)', textAlign: 'center' }}>
          No user tables found.
        </p>
      ) : (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Schema', 'Table', 'Rows', 'Size'].map((h) => (
                <th key={h} style={{
                  padding: '8px 20px', textAlign: h === 'Rows' || h === 'Size' ? 'right' : 'left',
                  fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
                  color: 'var(--text-3)', fontWeight: 500,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.topTables.map((t) => (
              <tr key={`${t.schema}.${t.name}`} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                <td style={{ padding: '8px 20px', color: 'var(--text-3)' }}>{t.schema}</td>
                <td style={{ padding: '8px 20px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.name}</td>
                <td style={{ padding: '8px 20px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {t.rowCount.toLocaleString()}
                </td>
                <td style={{ padding: '8px 20px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {formatBytes(t.sizeBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ── Active queries ────────────────────────────────────────────────────────────

function ActiveQueriesPanel({ data }: { data: SqlMonitorSnapshot }) {
  return (
    <Card padded={false}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionLabel>Active queries</SectionLabel>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {data.activeQueries.length} running
        </span>
      </div>
      {data.activeQueries.length === 0 ? (
        <p style={{ padding: '20px', fontSize: 13, color: 'var(--text-3)', textAlign: 'center' }}>
          No active queries.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['PID', 'User', 'Database', 'State', 'Duration', 'Query'].map((h) => (
                  <th key={h} style={{
                    padding: '8px 20px', textAlign: h === 'Duration' ? 'right' : 'left',
                    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
                    color: 'var(--text-3)', fontWeight: 500,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.activeQueries.map((q) => (
                <tr key={q.pid} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '8px 20px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{q.pid}</td>
                  <td style={{ padding: '8px 20px', color: 'var(--text-3)' }}>{q.user || '—'}</td>
                  <td style={{ padding: '8px 20px', color: 'var(--text-3)' }}>{q.database || '—'}</td>
                  <td style={{ padding: '8px 20px' }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 4,
                      background: 'var(--rail)', fontSize: 11,
                    }}>{q.state || 'active'}</span>
                  </td>
                  <td style={{ padding: '8px 20px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {formatDuration(q.durationMs)}
                  </td>
                  <td style={{ padding: '8px 20px', fontFamily: 'var(--font-mono)', fontSize: 11, maxWidth: 360 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={q.query}>
                      {q.query}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = s / 60
  if (m < 60) return `${m.toFixed(1)}m`
  return `${(m / 60).toFixed(1)}h`
}
