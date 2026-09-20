import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight, Play, Pause, Trash2, AlertTriangle, CheckCircle2,
  Loader2, RefreshCw, Zap, Info,
} from 'lucide-react'
import {
  api,
  type Connection,
  type CdcSyncJob,
  type CreateCdcSyncBody,
} from '../lib/api'
import { formatDate } from '../lib/utils'
import { EngineBadge } from '../components/shared/EngineBadge'

// ─────────────────────────────────────────────────────────────────────────────
// Sync page — Phase 4E
//
// CDC-based continuous replication between databases. Distinct from:
//   • Migrate (one-shot bounded copy)
//   • Move    (one-time export to file)
//
// Tabs:
//   • New Sync   — wizard: src → dst → bootstrap mode → namespaces → start
//   • Active     — running/paused CDC jobs with live event counters
// ─────────────────────────────────────────────────────────────────────────────

type Tab = 'wizard' | 'active'

export function SyncPage() {
  const [tab, setTab] = useState<Tab>('wizard')

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">Sync</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Continuous CDC replication between MongoDB, Postgres, and MySQL.
        Source writes are streamed to the destination in near real-time.
      </p>

      <div className="flex gap-1 border-b border-border mb-6">
        {(['wizard', 'active'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm ${
              tab === t
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'wizard' ? 'New Sync' : 'Active Syncs'}
          </button>
        ))}
      </div>

      {tab === 'wizard' ? <WizardTab onCreated={() => setTab('active')} /> : <ActiveTab />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard
// ─────────────────────────────────────────────────────────────────────────────

function WizardTab({ onCreated }: { onCreated: () => void }) {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  const [name, setName] = useState('')
  const [srcId, setSrcId] = useState<string>('')
  const [dstId, setDstId] = useState<string>('')
  const [srcDb, setSrcDb] = useState('')
  const [dstDb, setDstDb] = useState('')
  const [bootstrap, setBootstrap] = useState<'snapshot' | 'tail'>('snapshot')

  const src = connections.find((c) => c.id === srcId)
  const dst = connections.find((c) => c.id === dstId)

  // For MySQL/Postgres targets pre-fill destination DB from source DB.
  useEffect(() => {
    if (!dst) return
    if (dst.dbType === 'mongodb') return
    if (!dstDb && srcDb) setDstDb(srcDb)
  }, [dst, srcDb, dstDb])

  const createMutation = useMutation({
    mutationFn: (body: CreateCdcSyncBody) => api.post<CdcSyncJob>('/api/cdc-sync', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cdc-sync-jobs'] })
      onCreated()
    },
  })

  const canSubmit =
    name.trim().length > 0 &&
    !!srcId && !!dstId && srcId !== dstId &&
    (src?.dbType !== 'mongodb' ? !!srcDb : true) &&
    (dst?.dbType !== 'mongodb' ? !!dstDb : true)

  const submit = () => {
    if (!canSubmit) return
    createMutation.mutate({
      name: name.trim(),
      sourceConnId: srcId,
      destConnId: dstId,
      sourceDatabase: srcDb || undefined,
      destDatabase:   dstDb || undefined,
      bootstrap,
    })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Sync details</h2>

        <Field label="Sync name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. orders-mongo-to-pg-replica"
            className="w-full bg-input border border-border rounded px-3 py-2 text-sm"
          />
        </Field>

        <div className="grid grid-cols-[1fr,auto,1fr] gap-4 items-end mt-4">
          <Field label="Source">
            <select
              value={srcId}
              onChange={(e) => setSrcId(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm"
            >
              <option value="">Select source…</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.dbType})
                </option>
              ))}
            </select>
          </Field>
          <ArrowRight className="h-5 w-5 text-muted-foreground mb-2" />
          <Field label="Destination">
            <select
              value={dstId}
              onChange={(e) => setDstId(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm"
            >
              <option value="">Select destination…</option>
              {connections
                .filter((c) => c.id !== srcId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.dbType})
                  </option>
                ))}
            </select>
          </Field>
        </div>

        {src && dst && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <Field
              label={
                src.dbType === 'mongodb' ? 'Source database (optional)'
                : src.dbType === 'postgres' ? 'Source schema'
                : 'Source database'
              }
            >
              <input
                type="text"
                value={srcDb}
                onChange={(e) => setSrcDb(e.target.value)}
                placeholder={src.dbType === 'postgres' ? 'public' : 'testdb'}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono"
              />
            </Field>
            <Field
              label={
                dst.dbType === 'mongodb' ? 'Dest database (optional)'
                : dst.dbType === 'postgres' ? 'Dest schema'
                : 'Dest database'
              }
            >
              <input
                type="text"
                value={dstDb}
                onChange={(e) => setDstDb(e.target.value)}
                placeholder={dst.dbType === 'postgres' ? 'public' : 'testdb'}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono"
              />
            </Field>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Bootstrap mode</h2>
        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              checked={bootstrap === 'snapshot'}
              onChange={() => setBootstrap('snapshot')}
              className="mt-1"
            />
            <div>
              <div className="text-sm font-medium">Snapshot + tail (recommended)</div>
              <div className="text-xs text-muted-foreground">
                Run a full one-shot copy of existing data first, then switch to streaming
                changes from the moment the snapshot started. Guarantees the destination
                ends up identical to the source.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              checked={bootstrap === 'tail'}
              onChange={() => setBootstrap('tail')}
              className="mt-1"
            />
            <div>
              <div className="text-sm font-medium">Tail only</div>
              <div className="text-xs text-muted-foreground">
                Assume destination is already populated. Stream changes from "now"
                without copying existing data. Faster start but the destination won't
                match the source until every existing row is touched.
              </div>
            </div>
          </label>
        </div>
      </div>

      {src && dst && <SetupHints src={src.dbType} dst={dst.dbType} />}

      <div className="flex justify-end gap-2">
        <button
          onClick={submit}
          disabled={!canSubmit || createMutation.isPending}
          className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Start sync
        </button>
      </div>

      {createMutation.isError && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-sm text-destructive">
          {(createMutation.error as Error).message}
        </div>
      )}
    </div>
  )
}

/**
 * Setup hints for each source engine — surface the server-side config the
 * user has to enable (REPLICATION grants, wal_level, binlog) so they aren't
 * surprised when a sync fails on the first heartbeat.
 */
function SetupHints({ src, dst }: { src: string; dst: string }) {
  const hints: Array<{ engine: string; lines: string[] }> = []
  if (src === 'postgres') {
    hints.push({
      engine: 'Postgres source',
      lines: [
        'Server must have `wal_level = logical` (default on Supabase / RDS / Cloud SQL).',
        'Connection user needs the REPLICATION attribute: `ALTER USER <user> WITH REPLICATION;`',
        'Tables without a primary key need `ALTER TABLE <t> REPLICA IDENTITY FULL;`',
      ],
    })
  }
  if (src === 'mysql') {
    hints.push({
      engine: 'MySQL source',
      lines: [
        'Server must have binary logging on: `log_bin = ON`, `binlog_format = ROW`.',
        'User needs replication grants: `GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO …`',
      ],
    })
  }
  if (src === 'mongodb') {
    hints.push({
      engine: 'MongoDB source',
      lines: [
        'Must be a replica set (Atlas + our test fixture both qualify).',
        'Standalone mongod has no oplog and change streams will fail at open.',
      ],
    })
  }
  if (dst === 'mysql') {
    hints.push({
      engine: 'MySQL destination',
      lines: [
        'Migration user needs CREATE DATABASE privilege if the dest database doesn\'t exist.',
      ],
    })
  }
  if (hints.length === 0) return null

  return (
    <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4">
      <div className="flex items-start gap-2">
        <Info className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
        <div className="text-xs space-y-3">
          {hints.map((h) => (
            <div key={h.engine}>
              <div className="font-semibold mb-1">{h.engine}</div>
              <ul className="space-y-0.5 text-muted-foreground">
                {h.lines.map((l, i) => (
                  <li key={i}>• {l}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Active Syncs list
// ─────────────────────────────────────────────────────────────────────────────

function ActiveTab() {
  const qc = useQueryClient()
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['cdc-sync-jobs'],
    queryFn: () => api.get<CdcSyncJob[]>('/api/cdc-sync'),
    refetchInterval: 3_000, // live counter feel — 3 s poll
  })

  const pauseMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/cdc-sync/${id}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cdc-sync-jobs'] }),
  })
  const startMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/cdc-sync/${id}/start`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cdc-sync-jobs'] }),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/cdc-sync/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cdc-sync-jobs'] }),
  })

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>
  }

  if (jobs.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-border rounded-lg">
        <Zap className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">
          No active syncs yet. Use the <span className="font-medium text-foreground">New Sync</span> tab
          to start a continuous replication job.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <SyncCard
          key={job.id}
          job={job}
          onPause={() => pauseMutation.mutate(job.id)}
          onStart={() => startMutation.mutate(job.id)}
          onDelete={() => {
            if (confirm(`Delete sync "${job.name}"? This stops replication and removes its history.`)) {
              deleteMutation.mutate(job.id)
            }
          }}
        />
      ))}
    </div>
  )
}

function SyncCard({
  job, onPause, onStart, onDelete,
}: {
  job: CdcSyncJob
  onPause: () => void
  onStart: () => void
  onDelete: () => void
}) {
  // Roll up event counts from the most recent run (poll-driven, so it
  // refreshes every 3 s).
  const latestRun = job.runs?.[0]
  const inserts = latestRun?.inserts ?? 0
  const updates = latestRun?.updates ?? 0
  const deletes = latestRun?.deletes ?? 0
  const errors  = latestRun?.errorsCount ?? 0

  const lag = job.lastEventAt
    ? Math.floor((Date.now() - new Date(job.lastEventAt).getTime()) / 1000)
    : null

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold truncate">{job.name}</h3>
            <StatusBadge status={job.status} />
            {job.bootstrap === 'tail' && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                tail-only
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <EngineBadge engine={job.sourceType} variant="icon" />
            <span>{job.source?.name ?? job.sourceType}</span>
            <ArrowRight className="h-3 w-3" />
            <EngineBadge engine={job.destType} variant="icon" />
            <span>{job.destination?.name ?? job.destType}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {job.status === 'paused' || job.status === 'failed' ? (
            <button
              onClick={onStart}
              title="Resume / restart sync"
              className="p-2 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
            >
              <Play className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={onPause}
              title="Pause sync"
              className="p-2 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
              disabled={job.pauseRequested}
            >
              <Pause className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onDelete}
            title="Delete sync"
            className="p-2 hover:bg-muted rounded text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3 mt-4 pt-4 border-t border-border">
        <Metric label="Inserts" value={inserts} accent="text-emerald-500" />
        <Metric label="Updates" value={updates} accent="text-sky-500" />
        <Metric label="Deletes" value={deletes} accent="text-rose-500" />
        <Metric label="Errors" value={errors} accent={errors > 0 ? 'text-amber-500' : 'text-muted-foreground'} />
        <Metric
          label="Last event"
          value={lag === null ? '—' : lag < 60 ? `${lag}s ago` : lag < 3600 ? `${Math.floor(lag / 60)}m ago` : `${Math.floor(lag / 3600)}h ago`}
        />
      </div>

      {job.lastError && (
        <div className="mt-3 text-xs bg-destructive/10 border border-destructive/20 rounded px-3 py-2 text-destructive flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="break-words font-mono">{job.lastError}</span>
        </div>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground flex items-center gap-2">
        <span>Created {formatDate(job.createdAt)}</span>
        {latestRun && (
          <>
            <span>•</span>
            <span>Run started {formatDate(latestRun.startedAt)}</span>
          </>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: CdcSyncJob['status'] }) {
  const styles: Record<CdcSyncJob['status'], { label: string; cls: string; icon?: typeof Loader2 }> = {
    queued:         { label: 'queued',        cls: 'bg-muted text-muted-foreground' },
    bootstrapping:  { label: 'bootstrapping', cls: 'bg-sky-500/15 text-sky-500',     icon: Loader2 },
    tailing:        { label: 'tailing',       cls: 'bg-emerald-500/15 text-emerald-500', icon: RefreshCw },
    paused:         { label: 'paused',        cls: 'bg-amber-500/15 text-amber-500' },
    failed:         { label: 'failed',        cls: 'bg-destructive/15 text-destructive' },
  }
  const s = styles[status]
  const Icon = s.icon
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${s.cls}`}>
      {Icon && <Icon className="h-2.5 w-2.5 animate-spin" />}
      {s.label}
    </span>
  )
}

function Metric({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{label}</div>
      <div className={`text-lg font-semibold ${accent ?? ''}`}>{value}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  )
}

// Suppress "imported but unused" for CheckCircle2 we may want later.
void CheckCircle2
