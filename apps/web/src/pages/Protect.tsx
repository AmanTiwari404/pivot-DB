import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Play, Trash2, Pause, RotateCcw, Download, ChevronRight,
  Database, Clock, HardDrive, CheckCircle2, XCircle, Loader2, AlertCircle,
  Upload, AlertTriangle, Calendar,
} from 'lucide-react'
import { api, type Connection, type BackupJob, type BackupRun, type RestoreRun } from '../lib/api'
import { formatBytes, formatDate, humanCron } from '../lib/utils'

// ── Authenticated file download ───────────────────────────────────────────────
async function downloadRun(runId: string, filename: string) {
  const token = localStorage.getItem('token')
  const res = await fetch(`/api/backup/runs/${runId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
    throw new Error(err.error ?? res.statusText)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── helpers ───────────────────────────────────────────────────────────────────

function durationStr(start: string, end?: string): string {
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-xs text-muted-foreground">Never run</span>
  const map: Record<string, { icon: React.ReactNode; cls: string; label: string }> = {
    success: { icon: <CheckCircle2 className="h-3 w-3" />, cls: 'text-emerald-500', label: 'Success' },
    failed:  { icon: <XCircle     className="h-3 w-3" />, cls: 'text-destructive',  label: 'Failed'  },
    running: { icon: <Loader2     className="h-3 w-3 animate-spin" />, cls: 'text-amber-500', label: 'Running' },
    queued:  { icon: <Clock       className="h-3 w-3" />, cls: 'text-muted-foreground', label: 'Queued' },
  }
  const s = map[status] ?? { icon: <AlertCircle className="h-3 w-3" />, cls: 'text-muted-foreground', label: status }
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${s.cls}`}>
      {s.icon}{s.label}
    </span>
  )
}

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  return parts.length === 5 && parts.every((p) => p.length > 0)
}

// ── Quick cron presets ────────────────────────────────────────────────────────
const CRON_PRESETS = [
  { label: 'Every hour',     value: '0 * * * *'   },
  { label: 'Every 6 hours',  value: '0 */6 * * *' },
  { label: 'Daily 2AM',      value: '0 2 * * *'   },
  { label: 'Weekly Sun 2AM', value: '0 2 * * 0'   },
  { label: 'Monthly 1st',    value: '0 2 1 * *'   },
]

// ── Main page ─────────────────────────────────────────────────────────────────
export function ProtectPage() {
  const [tab, setTab] = useState<'jobs' | 'catalog'>('jobs')
  return (
    <div style={{ padding: 24, maxWidth: 1152, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 24px', fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
        Protect
      </h1>
      <div style={{
        display: 'flex', gap: 4, marginBottom: 24,
        borderBottom: '1px solid var(--border-soft)',
      }}>
        {(['jobs', 'catalog'] as const).map((t) => {
          const on = tab === t
          return (
            <button key={t} onClick={() => setTab(t)}
              style={{
                padding: '8px 16px', fontSize: 13,
                border: 'none', background: 'transparent',
                cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize',
                color: on ? 'var(--accent)' : 'var(--text-3)',
                borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}>{t === 'jobs' ? 'Backup Jobs' : 'Catalog'}</button>
          )
        })}
      </div>
      {tab === 'jobs'    && <BackupJobsTab />}
      {tab === 'catalog' && <CatalogTab />}
    </div>
  )
}

// ── Backup Jobs Tab ───────────────────────────────────────────────────────────
function BackupJobsTab() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [drawerJobId, setDrawerJobId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [editScheduleId, setEditScheduleId] = useState<string | null>(null)

  // Restore workflow state
  const [restoreTarget, setRestoreTarget] = useState<{ run: BackupRun; defaultConnectionId: string } | null>(null)
  const [restoreInFlight, setRestoreInFlight] = useState<string | null>(null) // restoreRunId being watched

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['backup-jobs'],
    queryFn: () => api.get<BackupJob[]>('/api/backup/jobs'),
    refetchInterval: 10_000,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/backup/jobs/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backup-jobs'] }); setDeleteConfirm(null) },
  })

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<BackupJob> }) =>
      api.patch(`/api/backup/jobs/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-jobs'] }),
  })

  const runMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/backup/jobs/${id}/run`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-jobs'] }),
  })

  const drawerJob = jobs.find((j) => j.id === drawerJobId) ?? null
  const deleteJob = jobs.find((j) => j.id === deleteConfirm) ?? null
  const editJob   = jobs.find((j) => j.id === editScheduleId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90">
          <Plus className="h-4 w-4" />
          New Backup Job
        </button>
      </div>

      {showForm && (
        <CreateJobForm
          connections={connections}
          onCreated={() => { setShowForm(false); qc.invalidateQueries({ queryKey: ['backup-jobs'] }) }}
        />
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 bg-card border border-border rounded-lg animate-pulse" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
          <HardDrive className="h-12 w-12 mb-3 opacity-30" />
          <p className="font-medium">No backup jobs yet</p>
          <p className="text-sm mt-1">Create your first backup job to protect your MongoDB data.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <BackupJobCard
              key={job.id}
              job={job}
              connection={connections.find((c) => c.id === job.connectionId)}
              isRunning={job.lastRunStatus === 'running'}
              onRun={() => runMutation.mutate(job.id)}
              onTogglePause={() =>
                patchMutation.mutate({ id: job.id, data: { status: job.status === 'active' ? 'paused' : 'active' } })
              }
              onOpenHistory={() => setDrawerJobId(job.id)}
              onEditSchedule={() => setEditScheduleId(job.id)}
              onDelete={() => setDeleteConfirm(job.id)}
              onRestore={(run) => setRestoreTarget({ run, defaultConnectionId: job.connectionId })}
              runMutating={runMutation.isPending}
            />
          ))}
        </div>
      )}

      {drawerJob && (
        <RunHistoryDrawer
          job={drawerJob}
          onClose={() => setDrawerJobId(null)}
          onRestore={(run) => setRestoreTarget({ run, defaultConnectionId: drawerJob.connectionId })}
        />
      )}

      {editJob && (
        <EditScheduleModal
          job={editJob}
          onClose={() => setEditScheduleId(null)}
          onSaved={() => { setEditScheduleId(null); qc.invalidateQueries({ queryKey: ['backup-jobs'] }) }}
        />
      )}

      {restoreTarget && (
        <RestoreModal
          run={restoreTarget.run}
          connections={connections}
          defaultConnectionId={restoreTarget.defaultConnectionId}
          onClose={() => setRestoreTarget(null)}
          onStarted={(restoreRunId) => { setRestoreTarget(null); setRestoreInFlight(restoreRunId) }}
        />
      )}

      {restoreInFlight && (
        <RestoreProgressDrawer
          restoreRunId={restoreInFlight}
          onClose={() => setRestoreInFlight(null)}
        />
      )}

      {deleteJob && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="font-semibold text-lg mb-2">Delete Backup Job</h3>
            <p className="text-sm text-muted-foreground mb-1">
              Delete <strong>{deleteJob.name}</strong>?
            </p>
            <p className="text-sm text-destructive mb-5">
              ⚠️ All backup files on disk will be permanently deleted.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm rounded border border-border hover:bg-secondary">
                Cancel
              </button>
              <button onClick={() => deleteMutation.mutate(deleteJob.id)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Backup Job Card (with inline 3-slot history) ──────────────────────────────
function BackupJobCard({
  job, connection, isRunning, onRun, onTogglePause, onOpenHistory, onEditSchedule,
  onDelete, onRestore, runMutating,
}: {
  job: BackupJob
  connection?: Connection
  isRunning: boolean
  onRun: () => void
  onTogglePause: () => void
  onOpenHistory: () => void
  onEditSchedule: () => void
  onDelete: () => void
  onRestore: (run: BackupRun) => void
  runMutating: boolean
}) {
  // Fetch the 3 most recent runs inline
  const { data: runs = [] } = useQuery({
    queryKey: ['backup-runs', job.id],
    queryFn: () => api.get<BackupRun[]>(`/api/backup/jobs/${job.id}/runs`),
    refetchInterval: 10_000,
  })

  const recentSuccess = runs.filter((r) => r.status === 'success').slice(0, 3)

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold truncate">{job.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              job.status === 'active' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-secondary text-muted-foreground'
            }`}>{job.status}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Database className="h-3 w-3" />
              {connection?.name ?? job.connectionId}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {humanCron(job.schedule)}
            </span>
            <span>{job.databases.length > 0 ? job.databases.join(', ') : 'All databases'}</span>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusBadge status={job.lastRunStatus ?? undefined} />
            {job.lastRunAt && <span className="text-xs text-muted-foreground">{relativeTime(job.lastRunAt)}</span>}
            {job.lastRunError && (
              <span className="text-xs text-destructive truncate max-w-xs" title={job.lastRunError}>
                {job.lastRunError}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onRun} disabled={isRunning || runMutating} title="Run now"
            className="p-2 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-primary disabled:opacity-40">
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          </button>
          <button onClick={onEditSchedule} title="Edit schedule"
            className="p-2 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-primary">
            <Calendar className="h-4 w-4" />
          </button>
          <button onClick={onTogglePause} title={job.status === 'active' ? 'Pause' : 'Resume'}
            className="p-2 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-primary">
            {job.status === 'active' ? <Pause className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
          </button>
          <button onClick={onOpenHistory} title="Full run history"
            className="p-2 rounded border border-border hover:border-primary/50 text-muted-foreground hover:text-primary">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button onClick={onDelete} title="Delete job"
            className="p-2 rounded border border-border hover:border-destructive/50 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Backup slots — max 3 */}
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Backup history (max 3)</p>
        {recentSuccess.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No successful backups yet.</p>
        ) : (
          <div className="space-y-1">
            {recentSuccess.map((run, idx) => (
              <div key={run.id} className="flex items-center gap-3 text-xs bg-secondary/20 rounded px-3 py-1.5">
                <span className="text-muted-foreground font-mono w-6">#{idx + 1}</span>
                <span className="flex-1">{formatDate(run.startedAt)}</span>
                <span className="text-muted-foreground w-20 text-right">
                  {run.sizeBytes ? formatBytes(Number(run.sizeBytes)) : '—'}
                </span>
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                <button onClick={() => onRestore(run)}
                  className="flex items-center gap-1 text-primary hover:underline">
                  <Upload className="h-3 w-3" />
                  Restore
                </button>
                <DownloadButton runId={run.id}
                  filename={`backup-${run.id}.tar.gz${run.filePath?.endsWith('.enc') ? '.enc' : ''}`}
                  compact />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Create Job Form ───────────────────────────────────────────────────────────
function CreateJobForm({ connections, onCreated }: { connections: Connection[]; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [connId, setConnId] = useState('')
  const [databases, setDatabases] = useState<string[]>([])
  const [dbInput, setDbInput] = useState('')
  const [schedule, setSchedule] = useState('0 2 * * *')
  const [retentionDays, setRetentionDays] = useState(30)

  const cronHuman = useMemo(() => humanCron(schedule), [schedule])

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/backup/jobs', {
      name, connectionId: connId, databases, schedule, retentionDays,
    }),
    onSuccess: onCreated,
  })

  const addDb = () => {
    const db = dbInput.trim()
    if (db && !databases.includes(db)) setDatabases((prev) => [...prev, db])
    setDbInput('')
  }

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <h2 className="font-semibold mb-4">Create Backup Job</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Job Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly production backup"
            className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Connection</label>
          <select value={connId} onChange={(e) => setConnId(e.target.value)}
            className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
            <option value="">Select connection…</option>
            {/* All engines supported as of Phase 3B. Each engine uses its
                native dump/restore CLI on the backend:
                  mongodb  → mongodump   / mongorestore
                  postgres → pg_dump -Fc / pg_restore
                  mysql    → mysqldump   / mysql */}
            {connections.map((c) =>
              <option key={c.id} value={c.id}>{c.name} ({c.dbType})</option>
            )}
          </select>
        </div>

        {/* The Databases field is meaningful for Mongo (multi-DB cluster) and
            MySQL (mysqldump --databases). PG connections are bound to a
            single DB by URI, so the field is hidden for PG. */}
        {(() => {
          const conn = connections.find((c) => c.id === connId)
          if (conn?.dbType === 'postgres') {
            return (
              <div className="col-span-2 bg-secondary/40 border border-border rounded px-3 py-2 text-xs text-muted-foreground">
                Postgres connections back up the database in the connection URI.
                To back up a different database, add a separate connection.
              </div>
            )
          }
          const isMysql = conn?.dbType === 'mysql'
          const helpText = isMysql
            ? '(leave empty = the database in the connection URI)'
            : '(leave empty = all databases)'
          const placeholderText = isMysql
            ? 'e.g. mydb — press Enter to add'
            : 'e.g. myapp_prod — press Enter to add'
          return (
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">
                Databases to back up <span className="text-muted-foreground/60">{helpText}</span>
              </label>
              <div className="flex gap-2">
                <input value={dbInput} onChange={(e) => setDbInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addDb()}
                  placeholder={placeholderText}
                  className="flex-1 bg-input border border-border rounded px-3 py-2 text-sm" />
                <button onClick={addDb} className="px-3 py-2 text-sm rounded border border-border hover:bg-secondary">
                  Add
                </button>
              </div>
              {databases.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {databases.map((db) => (
                    <span key={db} className="flex items-center gap-1 bg-secondary px-2 py-1 rounded text-xs">
                      {db}
                      <button onClick={() => setDatabases((prev) => prev.filter((d) => d !== db))}
                        className="text-muted-foreground hover:text-destructive ml-1">×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })()}

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Schedule (cron)</label>
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)}
            className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono" />
          <p className="text-xs text-primary mt-1">{cronHuman}</p>
          <div className="flex flex-wrap gap-1 mt-2">
            {CRON_PRESETS.map((p) => (
              <button key={p.value} onClick={() => setSchedule(p.value)}
                className={`text-xs px-2 py-0.5 rounded border ${schedule === p.value ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:border-primary/50'}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Retention (days)</label>
          <input type="number" min={1} max={365} value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          <p className="text-xs text-muted-foreground mt-1">
            Note: only the 3 most recent successful backups are kept on disk.
          </p>
        </div>
      </div>

      {createMutation.isError && (
        <p className="text-sm text-destructive mt-3">{(createMutation.error as Error).message}</p>
      )}

      <div className="flex gap-3 mt-4">
        <button onClick={() => createMutation.mutate()}
          disabled={!name || !connId || !schedule || createMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50">
          <Plus className="h-4 w-4" />
          {createMutation.isPending ? 'Creating…' : 'Create Backup Job'}
        </button>
      </div>
    </div>
  )
}

// ── Edit Schedule Modal ───────────────────────────────────────────────────────
function EditScheduleModal({
  job, onClose, onSaved,
}: { job: BackupJob; onClose: () => void; onSaved: () => void }) {
  const [schedule, setSchedule] = useState(job.schedule)
  const [retentionDays, setRetentionDays] = useState(job.retentionDays)
  const valid = isValidCron(schedule)
  const human = useMemo(() => (valid ? humanCron(schedule) : 'Invalid cron expression'), [schedule, valid])

  const save = useMutation({
    mutationFn: () => api.patch(`/api/backup/jobs/${job.id}`, { schedule, retentionDays }),
    onSuccess: onSaved,
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl">
        <h3 className="font-semibold text-lg mb-4">Edit Schedule — {job.name}</h3>

        <label className="text-xs text-muted-foreground mb-1 block">Cron expression</label>
        <input value={schedule} onChange={(e) => setSchedule(e.target.value)}
          className={`w-full bg-input border rounded px-3 py-2 text-sm font-mono ${
            valid ? 'border-border' : 'border-destructive'
          }`} />
        <p className={`text-xs mt-1 ${valid ? 'text-primary' : 'text-destructive'}`}>{human}</p>

        <div className="flex flex-wrap gap-1 mt-3">
          {CRON_PRESETS.map((p) => (
            <button key={p.value} onClick={() => setSchedule(p.value)}
              className={`text-xs px-2 py-0.5 rounded border ${
                schedule === p.value ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:border-primary/50'
              }`}>
              {p.label}
            </button>
          ))}
        </div>

        <label className="text-xs text-muted-foreground mb-1 block mt-5">Retention days (informational)</label>
        <input type="number" min={1} max={365} value={retentionDays}
          onChange={(e) => setRetentionDays(Number(e.target.value))}
          className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
        <p className="text-xs text-muted-foreground mt-1">
          Currently only the 3 most recent successful backups are kept on disk.
        </p>

        {save.isError && (
          <p className="text-sm text-destructive mt-3">{(save.error as Error).message}</p>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-border hover:bg-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
            className="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Restore Modal ─────────────────────────────────────────────────────────────
function RestoreModal({
  run, connections, defaultConnectionId, onClose, onStarted,
}: {
  run: BackupRun
  connections: Connection[]
  defaultConnectionId: string
  onClose: () => void
  onStarted: (restoreRunId: string) => void
}) {
  const [targetConnectionId, setTargetConnectionId] = useState(defaultConnectionId)
  const [confirmed, setConfirmed] = useState(false)

  const start = useMutation({
    mutationFn: () =>
      api.post<{ restoreRunId: string; status: string }>(`/api/backup/runs/${run.id}/restore`, { targetConnectionId }),
    onSuccess: (data) => onStarted(data.restoreRunId),
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl">
        <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
          <Upload className="h-5 w-5 text-amber-500" />
          Restore Backup
        </h3>

        <div className="bg-destructive/10 border border-destructive/40 rounded p-3 mb-4 flex gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">
            <strong>This will DROP and replace all collections</strong> in the target database with data from this
            backup point. This cannot be undone.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Backup point</label>
            <div className="bg-secondary/30 rounded px-3 py-2 text-sm">
              {formatDate(run.startedAt)} — {run.sizeBytes ? formatBytes(Number(run.sizeBytes)) : '—'}
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Restore to (target connection)</label>
            <select value={targetConnectionId}
              onChange={(e) => setTargetConnectionId(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.id === defaultConnectionId ? ' (original)' : ''}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5" />
            <span>I understand this will overwrite existing data in the target database</span>
          </label>
        </div>

        {start.isError && (
          <p className="text-sm text-destructive mt-3">{(start.error as Error).message}</p>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-border hover:bg-secondary">Cancel</button>
          <button onClick={() => start.mutate()}
            disabled={!confirmed || !targetConnectionId || start.isPending}
            className="px-4 py-2 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
            {start.isPending ? 'Starting…' : 'Restore Now'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Restore Progress Drawer ───────────────────────────────────────────────────
function RestoreProgressDrawer({
  restoreRunId, onClose,
}: { restoreRunId: string; onClose: () => void }) {
  const { data: restore } = useQuery({
    queryKey: ['restore-run', restoreRunId],
    queryFn: () => api.get<RestoreRun>(`/api/backup/restore/${restoreRunId}`),
    refetchInterval: (q) => {
      const r = q.state.data as RestoreRun | undefined
      return r && (r.status === 'success' || r.status === 'failed') ? false : 2000
    },
  })

  // Live-update duration while running
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!restore || restore.status === 'success' || restore.status === 'failed') return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [restore?.status])

  const duration = restore?.startedAt
    ? durationStr(restore.startedAt, restore.finishedAt)
    : '—'

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="w-full max-w-2xl bg-card border-l border-border flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Restore in Progress
            </h2>
            {restore?.backupRun?.job && (
              <p className="text-xs text-muted-foreground">
                From {restore.backupRun.job.name} → {restore.targetConnection?.name}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4" data-tick={tick}>
          {!restore ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <InfoRow label="Status"><StatusBadge status={restore.status} /></InfoRow>
                <InfoRow label="Duration">{duration}</InfoRow>
                {restore.backupRun && (
                  <InfoRow label="Backup point">{formatDate(restore.backupRun.startedAt)}</InfoRow>
                )}
                {restore.targetConnection && (
                  <InfoRow label="Target">{restore.targetConnection.name}</InfoRow>
                )}
              </div>

              {restore.status === 'success' && (
                <div className="bg-emerald-500/10 border border-emerald-500/40 rounded p-3 text-sm text-emerald-600 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> Restore completed successfully.
                </div>
              )}

              {restore.status === 'failed' && (
                <div className="bg-destructive/10 border border-destructive/40 rounded p-3 text-sm text-destructive flex items-start gap-2">
                  <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium mb-1">Restore failed</p>
                    <p className="text-xs">{restore.log ?? 'No error details available.'}</p>
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">mongorestore output</p>
                <pre className="bg-black/40 text-xs font-mono p-3 rounded border border-border overflow-x-auto whitespace-pre-wrap max-h-96">
                  {restore.log ?? (restore.status === 'queued' ? 'Waiting in queue…' : 'Running…')}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  )
}

// ── Download button ───────────────────────────────────────────────────────────
function DownloadButton({
  runId, filename, compact,
}: { runId: string; filename: string; compact?: boolean }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await downloadRun(runId, filename)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [runId, filename])

  return (
    <div className={compact ? '' : 'text-right'}>
      <button onClick={handleClick} disabled={loading}
        className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        {loading ? 'Downloading…' : 'Download'}
      </button>
      {error && <p className="text-xs text-destructive mt-0.5">{error}</p>}
    </div>
  )
}

// ── Run History Drawer ────────────────────────────────────────────────────────
function RunHistoryDrawer({
  job, onClose, onRestore,
}: { job: BackupJob; onClose: () => void; onRestore: (run: BackupRun) => void }) {
  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['backup-runs', job.id],
    queryFn: () => api.get<BackupRun[]>(`/api/backup/jobs/${job.id}/runs`),
    refetchInterval: 8_000,
  })

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="w-full max-w-2xl bg-card border-l border-border flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="font-semibold">{job.name}</h2>
            <p className="text-xs text-muted-foreground">{humanCron(job.schedule)}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-12 bg-secondary rounded animate-pulse" />)}
            </div>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">No runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground uppercase">
                  <th className="text-left pb-2">Started</th>
                  <th className="text-left pb-2">Duration</th>
                  <th className="text-left pb-2">Size</th>
                  <th className="text-left pb-2">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-border/30 hover:bg-secondary/10">
                    <td className="py-2 pr-4 text-xs">{formatDate(run.startedAt)}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {run.finishedAt ? durationStr(run.startedAt, run.finishedAt) : '—'}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {run.sizeBytes ? formatBytes(Number(run.sizeBytes)) : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={run.status} />
                      {run.errorMsg && (
                        <p className="text-xs text-destructive mt-0.5 max-w-xs truncate" title={run.errorMsg}>
                          {run.errorMsg}
                        </p>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {run.status === 'success' && (
                        <div className="flex items-center gap-3 justify-end">
                          <button onClick={() => onRestore(run)}
                            className="flex items-center gap-1 text-xs text-primary hover:underline">
                            <Upload className="h-3 w-3" /> Restore
                          </button>
                          <DownloadButton runId={run.id}
                            filename={`backup-${run.id}.tar.gz${run.filePath?.endsWith('.enc') ? '.enc' : ''}`}
                            compact />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Catalog Tab ───────────────────────────────────────────────────────────────
function CatalogTab() {
  const { data: jobs = [] } = useQuery({
    queryKey: ['backup-jobs'],
    queryFn: () => api.get<BackupJob[]>('/api/backup/jobs'),
  })

  const { data: allRunsByJob = [] } = useQuery({
    queryKey: ['catalog-all-runs', jobs.map((j) => j.id).join(',')],
    queryFn: async () => {
      const results = await Promise.all(
        jobs.map((j) =>
          api.get<BackupRun[]>(`/api/backup/jobs/${j.id}/runs`).then((runs) =>
            runs.map((r) => ({ ...r, jobName: j.name, connection: j.connection?.name ?? j.connectionId }))
          )
        )
      )
      return results.flat()
    },
    enabled: jobs.length > 0,
    refetchInterval: 30_000,
  })

  const { data: restores = [] } = useQuery({
    queryKey: ['catalog-restores'],
    queryFn: () => api.get<RestoreRun[]>('/api/backup/restores'),
    refetchInterval: 10_000,
  })

  const successRuns = allRunsByJob.filter((r) => r.status === 'success')
  const totalBytes = successRuns.reduce((sum, r) => sum + Number(r.sizeBytes ?? 0), 0)

  return (
    <div className="space-y-6">
      {successRuns.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground mb-1">Total backups</p>
            <p className="text-2xl font-bold">{successRuns.length}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground mb-1">Total stored</p>
            <p className="text-2xl font-bold">{formatBytes(totalBytes)}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground mb-1">Backup jobs</p>
            <p className="text-2xl font-bold">{jobs.length}</p>
          </div>
        </div>
      )}

      {successRuns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
          <HardDrive className="h-12 w-12 mb-3 opacity-30" />
          <p className="font-medium">No backups yet</p>
          <p className="text-sm mt-1">Successful backup runs will appear here.</p>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wide">Backups</h3>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
                  <th className="text-left px-4 py-2">Job</th>
                  <th className="text-left px-4 py-2">Connection</th>
                  <th className="text-left px-4 py-2">Started</th>
                  <th className="text-left px-4 py-2">Databases</th>
                  <th className="text-left px-4 py-2">Size</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {successRuns
                  .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
                  .map((run) => (
                    <tr key={run.id} className="border-b border-border/30 hover:bg-secondary/10">
                      <td className="px-4 py-2 font-medium">{(run as typeof run & { jobName: string }).jobName}</td>
                      <td className="px-4 py-2 text-muted-foreground text-xs">{(run as typeof run & { connection: string }).connection}</td>
                      <td className="px-4 py-2 text-xs">{formatDate(run.startedAt)}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {run.databases.length > 0 ? run.databases.join(', ') : 'All'}
                      </td>
                      <td className="px-4 py-2 text-xs">{run.sizeBytes ? formatBytes(Number(run.sizeBytes)) : '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <DownloadButton runId={run.id}
                          filename={`backup-${run.id}.tar.gz${run.filePath?.endsWith('.enc') ? '.enc' : ''}`} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Restore history */}
      {restores.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wide">Restore History</h3>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
                  <th className="text-left px-4 py-2">Job</th>
                  <th className="text-left px-4 py-2">Backup Point</th>
                  <th className="text-left px-4 py-2">Target</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Duration</th>
                  <th className="text-left px-4 py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {restores.map((r) => (
                  <tr key={r.id} className="border-b border-border/30 hover:bg-secondary/10">
                    <td className="px-4 py-2 font-medium">{r.backupRun?.job?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-xs">
                      {r.backupRun?.startedAt ? formatDate(r.backupRun.startedAt) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs">{r.targetConnection?.name ?? '—'}</td>
                    <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {r.startedAt ? durationStr(r.startedAt, r.finishedAt) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs">{formatDate(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
