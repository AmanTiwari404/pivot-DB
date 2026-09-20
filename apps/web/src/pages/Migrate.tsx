import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Database, ArrowRight, Play, AlertTriangle, CheckCircle2,
  XCircle, Loader2, Trash2, ChevronRight, ChevronDown, Info,
} from 'lucide-react'
import {
  api,
  type Connection, type DbType,
  type PreviewResponse, type MigrationV2Job, type MigrationV2Run,
  type SchemaWarning, type CanonicalType,
} from '../lib/api'
import { useMigrationSocket } from '../hooks/useMigrationSocket'
import { formatDate } from '../lib/utils'
import { EngineBadge } from '../components/shared/EngineBadge'

// ─────────────────────────────────────────────────────────────────────────────
// Migrate page — Phase 1D wizard
//
// Tabs:
//   • Wizard     — 4-step flow: pick conns → preview → run → progress
//   • Saved Jobs — re-run / view past runs / delete
// ─────────────────────────────────────────────────────────────────────────────

type Tab = 'wizard' | 'jobs'

export function MigratePage() {
  const [tab, setTab] = useState<Tab>('wizard')

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">Migrate</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Move data between MongoDB, PostgreSQL, and MySQL. Schema is inferred automatically.
      </p>

      <div className="flex gap-1 border-b border-border mb-6">
        {(['wizard', 'jobs'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize ${
              tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {t === 'wizard' ? 'New Migration' : 'Saved Jobs'}
          </button>
        ))}
      </div>

      {tab === 'wizard' ? <WizardTab /> : <JobsTab />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = ['Source & Dest', 'Preview', 'Run'] as const
type StepIdx = 0 | 1 | 2

function WizardTab() {
  const qc = useQueryClient()
  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  const [step, setStep] = useState<StepIdx>(0)
  const [srcId, setSrcId] = useState('')
  const [dstId, setDstId] = useState('')
  const [name, setName] = useState('')
  const [sourceDatabase, setSourceDatabase] = useState('')
  const [destDatabase, setDestDatabase] = useState('')
  const [dropExisting, setDropExisting] = useState(true)
  const [sampleSize, setSampleSize] = useState(1000)
  const [batchSize, setBatchSize] = useState(1000)

  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [runId, setRunId] = useState<string | null>(null)

  const src = connections.find((c) => c.id === srcId)
  const dst = connections.find((c) => c.id === dstId)

  // Default migration name when both conns are picked
  useEffect(() => {
    if (src && dst && !name) setName(`${src.name} → ${dst.name}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId, dstId])

  // Sensible default destDatabase per *pair*, not just per destination.
  //
  // Auto-populating from source only makes sense when the two engines treat
  // the field as the same concept:
  //   • mongo  → mongo / mysql            ("database" maps cleanly)
  //   • mysql  → mongo / mysql            (likewise)
  //   • mysql  → postgres                 (use source db as PG schema name)
  //   • postgres → postgres               (source schema → dest schema)
  //   • postgres → *anything*             leave BLANK — PG "public" schema isn't
  //                                       a useful Mongo/MySQL database name.
  //   • mongo  → postgres                 default to "public" schema.
  useEffect(() => {
    if (destDatabase) return                       // user already typed something
    if (!dst?.dbType) return
    if (!sourceDatabase && dst.dbType !== 'postgres') return

    const srcType = src?.dbType
    // For the postgres-source case we deliberately do NOT auto-fill the
    // dest unless the dest is also postgres; the source's "public" schema
    // is rarely a useful Mongo / MySQL database name.
    if (srcType === 'postgres' && dst.dbType !== 'postgres') return

    if (dst.dbType === 'postgres') {
      setDestDatabase(srcType === 'postgres' ? sourceDatabase : 'public')
    } else {
      // mongo or mysql destination — mirror the source DB name.
      setDestDatabase(sourceDatabase)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDatabase, dstId])

  // All 9 pairs are supported (3 engines × 3 engines). Same-engine pairs
  // use IdentityMapper; cross-engine pairs use the dedicated mapper for
  // that direction. The only "unsupported" case is missing connections.
  const supportedPair = !!(src && dst && src.id !== dst.id)

  const previewMutation = useMutation({
    mutationFn: () => api.post<PreviewResponse>('/api/migration-v2/preview', {
      name, sourceConnId: srcId, destConnId: dstId,
      sourceDatabase: sourceDatabase || undefined,
      destDatabase: destDatabase || undefined,
      sampleSize, batchSize,
    }),
    onSuccess: (data) => {
      setPreview(data)
      setStep(1)
    },
  })

  const runMutation = useMutation({
    mutationFn: async () => {
      const job = await api.post<MigrationV2Job>('/api/migration-v2/jobs', {
        name, sourceConnId: srcId, destConnId: dstId,
        sourceDatabase: sourceDatabase || undefined,
        destDatabase: destDatabase || undefined,
        sampleSize, batchSize, dropExisting,
      })
      const run = await api.post<{ runId: string }>(`/api/migration-v2/jobs/${job.id}/run`, {})
      return run.runId
    },
    onSuccess: (id) => {
      setRunId(id)
      setStep(2)
      qc.invalidateQueries({ queryKey: ['migration-v2-jobs'] })
    },
  })

  const resetWizard = () => {
    setStep(0); setRunId(null); setPreview(null)
    setSrcId(''); setDstId(''); setName('')
    setSourceDatabase(''); setDestDatabase('')
  }

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 0 && (
        <Step1
          connections={connections}
          src={src} dst={dst} srcId={srcId} dstId={dstId}
          setSrcId={setSrcId} setDstId={setDstId}
          name={name} setName={setName}
          sourceDatabase={sourceDatabase} setSourceDatabase={setSourceDatabase}
          destDatabase={destDatabase} setDestDatabase={setDestDatabase}
          dropExisting={dropExisting} setDropExisting={setDropExisting}
          sampleSize={sampleSize} setSampleSize={setSampleSize}
          batchSize={batchSize} setBatchSize={setBatchSize}
          supportedPair={supportedPair}
          previewing={previewMutation.isPending}
          previewError={previewMutation.error?.message}
          onPreview={() => previewMutation.mutate()}
        />
      )}

      {step === 1 && preview && (
        <Step2
          preview={preview}
          onBack={() => setStep(0)}
          onRun={() => runMutation.mutate()}
          running={runMutation.isPending}
          runError={runMutation.error?.message}
          dropExisting={dropExisting}
          isMongoSource={src?.dbType === 'mongodb'}
        />
      )}

      {step === 2 && runId && (
        <Step3
          runId={runId}
          jobName={name}
          onDone={resetWizard}
        />
      )}
    </div>
  )
}

// ─── Stepper ────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: StepIdx }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold ${
            i < step  ? 'bg-primary text-primary-foreground' :
            i === step ? 'bg-primary/20 text-primary border border-primary' :
                         'bg-secondary text-muted-foreground'
          }`}>
            {i + 1}
          </div>
          <span className={`text-sm ${i === step ? 'font-semibold' : 'text-muted-foreground'}`}>{label}</span>
          {i < STEPS.length - 1 && <ChevronRight className="h-4 w-4 text-muted-foreground mx-1" />}
        </div>
      ))}
    </div>
  )
}

// ─── Step 1: Source & destination ───────────────────────────────────────────

function Step1(p: {
  connections: Connection[]
  src?: Connection; dst?: Connection
  srcId: string; dstId: string
  setSrcId: (s: string) => void; setDstId: (s: string) => void
  name: string; setName: (s: string) => void
  sourceDatabase: string; setSourceDatabase: (s: string) => void
  destDatabase: string;   setDestDatabase: (s: string) => void
  dropExisting: boolean; setDropExisting: (b: boolean) => void
  sampleSize: number; setSampleSize: (n: number) => void
  batchSize: number;  setBatchSize: (n: number) => void
  supportedPair: boolean
  previewing: boolean
  previewError?: string
  onPreview: () => void
}) {
  const { data: srcDatabases = [] } = useQuery({
    queryKey: ['db-list', p.srcId],
    queryFn: () =>
      api.get<{ dbType: DbType; databases: string[] }>(`/api/connections/${p.srcId}/databases`)
        .then(r => r.databases),
    enabled: !!p.srcId,
  })

  const isMongoSrc = p.src?.dbType === 'mongodb'

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Source & Destination</h2>

        <div className="grid grid-cols-2 gap-4">
          <ConnSelect label="Source" value={p.srcId}
            connections={p.connections} onChange={p.setSrcId} />
          <ConnSelect label="Destination" value={p.dstId}
            connections={p.connections.filter(c => c.id !== p.srcId)} onChange={p.setDstId} />
        </div>

        {p.src && p.dst && p.src.id === p.dst.id && (
          <p className="mt-3 text-xs text-amber-500 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Source and destination must be different connections.
          </p>
        )}

        {p.src && p.dst && p.src.id !== p.dst.id && (
          <div className="mt-3 flex items-center gap-2">
            <EngineBadge engine={p.src.dbType} />
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <EngineBadge engine={p.dst.dbType} />
            {p.src.dbType === p.dst.dbType && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                same engine
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 mt-4">
          <Field label={isMongoSrc ? 'Source database' : 'Source schema'}>
            {srcDatabases.length > 0 ? (
              <select
                value={p.sourceDatabase}
                onChange={(e) => p.setSourceDatabase(e.target.value)}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
                <option value="">Select…</option>
                {srcDatabases.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <input
                value={p.sourceDatabase}
                onChange={(e) => p.setSourceDatabase(e.target.value)}
                placeholder={isMongoSrc ? 'my_database' : 'public'}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono"
              />
            )}
          </Field>

          <Field label={
            p.dst?.dbType === 'mongodb' ? 'Dest database (optional)' :
            p.dst?.dbType === 'mysql'   ? 'Dest database' :
                                           'Dest schema'
          }>
            <input
              value={p.destDatabase}
              onChange={(e) => p.setDestDatabase(e.target.value)}
              placeholder={
                p.dst?.dbType === 'mongodb' ? '(matches source if blank)' :
                p.dst?.dbType === 'mysql'   ? 'testdb (must exist or user needs CREATE)' :
                                               'public'
              }
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono"
            />
            {p.dst?.dbType === 'mysql' && (
              <p className="text-xs text-muted-foreground mt-1">
                If this database doesn't exist, the migration user needs CREATE DATABASE privilege.
              </p>
            )}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <Field label="Migration name">
            <input
              value={p.name}
              onChange={(e) => p.setName(e.target.value)}
              placeholder="Atlas → Analytics PG"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Sample size (docs for inference)">
            <input
              type="number" min={50} max={100000}
              value={p.sampleSize}
              onChange={(e) => p.setSampleSize(Number(e.target.value))}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4 items-end">
          <Field label="Batch size (rows per write)">
            <input
              type="number" min={50} max={10000}
              value={p.batchSize}
              onChange={(e) => p.setBatchSize(Number(e.target.value))}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm cursor-pointer pb-2">
            <input
              type="checkbox"
              checked={p.dropExisting}
              onChange={(e) => p.setDropExisting(e.target.checked)}
              className="rounded border-border"
            />
            Drop destination tables/collections before writing
          </label>
        </div>

        {p.previewError && (
          <p className="mt-4 text-xs text-destructive flex items-start gap-1.5">
            <XCircle className="h-3.5 w-3.5 mt-0.5" />
            {p.previewError}
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={p.onPreview}
          disabled={!p.supportedPair || !p.sourceDatabase || !p.name || p.previewing}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          {p.previewing
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Inferring schemas…</>
            : <>Preview <ChevronRight className="h-4 w-4" /></>}
        </button>
      </div>
    </div>
  )
}

function ConnSelect({ label, value, connections, onChange }: {
  label: string; value: string; connections: Connection[]; onChange: (s: string) => void
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-input border border-border rounded px-3 py-2 text-sm">
        <option value="">Select…</option>
        {connections.map(c => (
          <option key={c.id} value={c.id}>{c.name} ({c.dbType})</option>
        ))}
      </select>
    </Field>
  )
}

// ─── Step 2: Preview ────────────────────────────────────────────────────────

function Step2({ preview, onBack, onRun, running, runError, dropExisting, isMongoSource }: {
  preview: PreviewResponse
  onBack: () => void
  onRun: () => void
  running: boolean
  runError?: string
  dropExisting: boolean
  isMongoSource: boolean
}) {
  const [expandedNs, setExpandedNs] = useState<Set<string>>(new Set())
  const toggleNs = (key: string) => {
    setExpandedNs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const totalDocs = preview.schemas.reduce((sum, s) => sum + (s.approxCount ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold">Inferred schema</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {preview.schemas.length} namespace{preview.schemas.length === 1 ? '' : 's'} ·
              ~{totalDocs.toLocaleString()} {isMongoSource ? 'docs' : 'rows'} ·
              {preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        {preview.schemas.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No namespaces found in the source database.
          </p>
        )}

        <div className="space-y-1">
          {preview.schemas.map((s) => {
            const key = `${s.namespace.database}.${s.namespace.name}`
            const isOpen = expandedNs.has(key)
            const nsWarnings = preview.warnings.filter(
              (w) => w.namespace.name === s.namespace.name &&
                     w.namespace.database === s.namespace.database
            )
            return (
              <div key={key} className="border border-border rounded">
                <button
                  onClick={() => toggleNs(key)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/40">
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <Database className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-sm">{s.namespace.database}.{s.namespace.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {s.columns.length} cols · ~{s.approxCount?.toLocaleString() ?? '?'} {isMongoSource ? 'docs' : 'rows'}
                  </span>
                  {nsWarnings.length > 0 && (
                    <span className="flex items-center gap-1 text-xs text-amber-500">
                      <AlertTriangle className="h-3 w-3" /> {nsWarnings.length}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="border-t border-border bg-background/50 p-3">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left py-1 pr-3">Column</th>
                          <th className="text-left py-1 pr-3">Type</th>
                          <th className="text-left py-1 pr-3">Null</th>
                          <th className="text-left py-1 pr-3">Key</th>
                          <th className="text-left py-1 pr-3">Presence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.columns.map((c) => (
                          <tr key={c.name} className="border-t border-border/40">
                            <td className="py-1 pr-3 font-mono">{c.name}</td>
                            <td className="py-1 pr-3"><TypeChip type={c.type} observed={c.observedTypes} /></td>
                            <td className="py-1 pr-3 text-muted-foreground">{c.nullable ? 'yes' : 'no'}</td>
                            <td className="py-1 pr-3 text-muted-foreground">
                              {c.primaryKey ? 'PK' : ''}
                              {c.references ? <span className="text-blue-400">FK → {c.references}</span> : ''}
                            </td>
                            <td className="py-1 pr-3 text-muted-foreground">
                              {c.presenceCount !== undefined ? `${c.presenceCount}` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {nsWarnings.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {nsWarnings.map((w, i) => <WarningLine key={i} w={w} />)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {preview.ddl.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-semibold mb-2">
              Generated DDL ({preview.ddl.length} statement{preview.ddl.length === 1 ? '' : 's'})
            </h3>
            <pre className="bg-secondary/40 border border-border rounded p-3 text-xs font-mono max-h-72 overflow-auto">
              {preview.ddl.join('\n\n')}
            </pre>
          </div>
        )}
      </div>

      {runError && (
        <p className="text-xs text-destructive flex items-center gap-1.5">
          <XCircle className="h-3.5 w-3.5" /> {runError}
        </p>
      )}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
          Back
        </button>
        <button
          onClick={onRun}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50 font-medium">
          {running
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting…</>
            : <>{dropExisting ? 'Drop + Migrate' : 'Migrate'} <Play className="h-3.5 w-3.5" /></>}
        </button>
      </div>
    </div>
  )
}

function TypeChip({ type, observed }: { type: CanonicalType; observed?: CanonicalType[] }) {
  const danger = type === 'mixed' || type === 'unknown' || type === 'null'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${
      danger ? 'bg-amber-500/15 text-amber-500' : 'bg-secondary text-foreground'
    }`} title={observed?.join(', ')}>
      {type}{observed && observed.length > 1 && '*'}
    </span>
  )
}

function WarningLine({ w }: { w: SchemaWarning }) {
  const Icon =
    w.severity === 'error' ? XCircle :
    w.severity === 'warn'  ? AlertTriangle :
                             Info
  const color =
    w.severity === 'error' ? 'text-destructive' :
    w.severity === 'warn'  ? 'text-amber-500' :
                             'text-muted-foreground'
  return (
    <p className={`text-xs flex items-start gap-1.5 ${color}`}>
      <Icon className="h-3 w-3 mt-0.5 flex-shrink-0" />
      <span>
        <span className="font-mono">{w.code}</span>
        {w.column && <span className="opacity-70"> · {w.column}</span>} —
        <span className="ml-1">{w.message}</span>
      </span>
    </p>
  )
}

// ─── Step 3: Run + live progress ────────────────────────────────────────────

function Step3({ runId, jobName, onDone }: { runId: string; jobName: string; onDone: () => void }) {
  const live = useMigrationSocket(runId)

  // Also poll the run row directly — covers the case where the socket misses
  // events because the run finished faster than the subscribe round-trip.
  const { data: runRow } = useQuery({
    queryKey: ['migration-v2-run', runId],
    queryFn: () => api.get<MigrationV2Run>(`/api/migration-v2/runs/${runId}`),
    refetchInterval: (q) => {
      const r = q.state.data
      if (!r) return 1000
      return r.phase === 'succeeded' || r.phase === 'failed' ||
             r.phase === 'cancelled' || r.phase === 'partial' ? false : 1000
    },
  })

  // Prefer socket data while it's flowing; fall back to polled row.
  const phase = live.phase ?? runRow?.phase ?? 'queued'
  const progress = Object.values(live.progress).length > 0
    ? live.progress
    : (runRow?.progress ?? {})
  const warnings = live.warnings.length > 0
    ? live.warnings
    : (runRow?.warnings ?? [])

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/api/migration-v2/runs/${runId}/cancel`),
  })

  const isTerminal = phase === 'succeeded' || phase === 'failed' ||
                     phase === 'cancelled' || phase === 'partial'

  // Tick once a second so elapsed time updates while running; freezes on
  // terminal so the value sticks at completion.
  const elapsed = useElapsed(runRow?.startedAt, runRow?.finishedAt)
  // Crude ETA: project current rows/sec against total namespaces × expected
  // rows. We only have totalWritten so far + the per-namespace approxCount
  // sum from progress ticks. Acceptable approximation for a multi-table run.
  const eta = computeEta(progress, runRow?.totalWritten ?? 0, elapsed)

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">{jobName}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">run {runId.slice(0, 12)}…</p>
          </div>
          <div className="flex items-center gap-3">
            {elapsed !== null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatDuration(elapsed)}
                {!isTerminal && eta !== null && eta > 1 && ` · ETA ${formatDuration(eta)}`}
              </span>
            )}
            <PhaseBadge phase={phase} connected={live.connected} />
          </div>
        </div>

        {runRow && (
          <div className="grid grid-cols-4 gap-3 mt-4">
            <Stat label="Namespaces" value={runRow.totalNamespaces} />
            <Stat label="Succeeded"  value={runRow.succeededNs} tone="success" />
            <Stat label="Written"    value={runRow.totalWritten.toLocaleString()} />
            <Stat label="Failed"     value={runRow.totalFailed}
              tone={runRow.totalFailed > 0 ? 'danger' : undefined} />
          </div>
        )}
      </div>

      {Object.keys(progress).length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-3">Per-namespace progress</h3>
          <div className="space-y-2">
            {Object.entries(progress).map(([key, p]) => (
              <NamespaceProgress key={key} ns={key} tick={p} />
            ))}
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" /> Warnings ({warnings.length})
          </h3>
          <div className="space-y-1 max-h-56 overflow-auto">
            {warnings.map((w, i) => <WarningLine key={i} w={w} />)}
          </div>
        </div>
      )}

      {runRow?.errors && Array.isArray(runRow.errors) && runRow.errors.length > 0 && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-3 text-destructive flex items-center gap-2">
            <XCircle className="h-4 w-4" /> Errors
          </h3>
          {runRow.errors.map((e, i) => (
            <p key={i} className="text-xs font-mono text-destructive">
              {e.namespace ? `${e.namespace.database}.${e.namespace.name}: ` : ''}{e.error}
            </p>
          ))}
        </div>
      )}

      <div className="flex justify-between">
        {!isTerminal ? (
          <button
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
            className="px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive disabled:opacity-50">
            {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : <span />}
        <button
          onClick={onDone}
          className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 font-medium">
          {isTerminal ? 'Start a new migration' : 'Run in background'}
        </button>
      </div>
    </div>
  )
}

function NamespaceProgress({ ns, tick }: {
  ns: string
  tick: {
    phase: string; written: number; skipped: number; failed: number;
    approxTotal?: number; error?: string
  }
}) {
  const pct = tick.approxTotal && tick.approxTotal > 0
    ? Math.min(100, Math.round((tick.written / tick.approxTotal) * 100))
    : tick.phase === 'done' ? 100 : null
  const phaseTone =
    tick.phase === 'done'    ? 'bg-green-500/15 text-green-500' :
    tick.phase === 'failed'  ? 'bg-destructive/15 text-destructive' :
                                'bg-blue-500/15 text-blue-400'

  return (
    <div className="p-3 bg-secondary/30 rounded">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-mono flex-1 truncate">{ns}</span>
        <span className={`text-xs px-2 py-0.5 rounded ${phaseTone}`}>{tick.phase}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {tick.written.toLocaleString()}
          {tick.approxTotal !== undefined && ` / ${tick.approxTotal.toLocaleString()}`}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-2 h-1.5 bg-secondary rounded overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {tick.error && (
        <p className="text-xs text-destructive mt-1">{tick.error}</p>
      )}
    </div>
  )
}

function PhaseBadge({ phase, connected }: { phase: string; connected: boolean }) {
  const tones: Record<string, string> = {
    queued:    'bg-secondary text-muted-foreground',
    running:   'bg-blue-500/15 text-blue-400',
    succeeded: 'bg-green-500/15 text-green-500',
    partial:   'bg-amber-500/15 text-amber-500',
    failed:    'bg-destructive/15 text-destructive',
    cancelled: 'bg-secondary text-muted-foreground',
  }
  const Icon =
    phase === 'succeeded' ? CheckCircle2 :
    phase === 'failed' || phase === 'partial' || phase === 'cancelled' ? XCircle :
    Loader2
  return (
    <div className="flex items-center gap-2">
      <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium ${tones[phase] ?? tones.queued}`}>
        <Icon className={`h-3 w-3 ${phase === 'running' || phase === 'queued' ? 'animate-spin' : ''}`} />
        {phase}
      </span>
      {!connected && phase === 'running' && (
        <span className="text-xs text-muted-foreground">socket reconnecting…</span>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'success' | 'danger' }) {
  const color = tone === 'success' ? 'text-green-500' :
                tone === 'danger'  ? 'text-destructive' :
                                     'text-foreground'
  return (
    <div className="bg-secondary/30 rounded p-2.5">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

// ─── Saved jobs tab ─────────────────────────────────────────────────────────

function JobsTab() {
  const qc = useQueryClient()
  const { data: jobs = [] } = useQuery({
    queryKey: ['migration-v2-jobs'],
    queryFn: () => api.get<MigrationV2Job[]>('/api/migration-v2/jobs'),
  })

  const runMutation = useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ runId: string }>(`/api/migration-v2/jobs/${jobId}/run`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-v2-jobs'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (jobId: string) => api.delete(`/api/migration-v2/jobs/${jobId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-v2-jobs'] }),
  })

  if (jobs.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-10 text-center">
        <Database className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No saved migration jobs yet.</p>
        <p className="text-xs text-muted-foreground mt-1">Create one via the <b>New Migration</b> tab.</p>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b border-border bg-secondary/20">
          <tr>
            <th className="text-left px-4 py-2">Name</th>
            <th className="text-left px-4 py-2">Source → Dest</th>
            <th className="text-left px-4 py-2">Last run</th>
            <th className="text-left px-4 py-2">Created</th>
            <th className="text-right px-4 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const lastRun = j.runs?.[0]
            return (
              <tr key={j.id} className="border-b border-border/40 hover:bg-secondary/20">
                <td className="px-4 py-2.5 font-medium">{j.name}</td>
                <td className="px-4 py-2.5 text-xs">
                  <span className="inline-flex items-center gap-1.5 align-middle">
                    <EngineBadge engine={j.sourceType} variant="icon" />
                    <span className="font-mono">{j.source?.name ?? '?'}</span>
                  </span>
                  <ArrowRight className="inline h-3 w-3 mx-2 text-muted-foreground align-middle" />
                  <span className="inline-flex items-center gap-1.5 align-middle">
                    <EngineBadge engine={j.destType} variant="icon" />
                    <span className="font-mono">{j.destination?.name ?? '?'}</span>
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {lastRun ? (
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <PhaseBadge phase={lastRun.phase} connected />
                      <span className="text-muted-foreground tabular-nums">
                        {lastRun.totalWritten.toLocaleString()} written
                      </span>
                      {lastRun.totalFailed > 0 && (
                        <span className="text-destructive tabular-nums">
                          · {lastRun.totalFailed.toLocaleString()} failed
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Never run</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(j.createdAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => runMutation.mutate(j.id)}
                    disabled={runMutation.isPending}
                    className="px-2 py-1 text-xs rounded border border-border hover:border-primary hover:text-primary mr-2 disabled:opacity-50"
                  >
                    <Play className="inline h-3 w-3 mr-1" /> Run
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete job "${j.name}"?`)) deleteMutation.mutate(j.id)
                    }}
                    disabled={deleteMutation.isPending}
                    className="px-2 py-1 text-xs rounded border border-border hover:border-destructive hover:text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="inline h-3 w-3" />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Tiny helpers ───────────────────────────────────────────────────────────

/**
 * Returns seconds elapsed between startedAt and now (or finishedAt if set).
 * Re-renders once a second while the run is still active.
 */
function useElapsed(startedAt: string | null | undefined, finishedAt: string | null | undefined): number | null {
  const [, force] = useState(0)
  useEffect(() => {
    if (!startedAt || finishedAt) return
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [startedAt, finishedAt])

  if (!startedAt) return null
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  return Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000))
}

/** "5s", "1m 23s", "1h 4m" */
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

/**
 * Project remaining seconds based on rows-written / elapsed.
 * Uses approxTotal from progress ticks when available; otherwise returns null
 * (we don't know what we don't know — better to show nothing than guess).
 */
function computeEta(
  progress: Record<string, { written: number; approxTotal?: number; failed: number; skipped: number }>,
  totalWritten: number,
  elapsedSec: number | null,
): number | null {
  if (!elapsedSec || elapsedSec < 2 || totalWritten === 0) return null
  let approxTotal = 0
  let hasApprox = false
  for (const p of Object.values(progress)) {
    if (typeof p.approxTotal === 'number') { approxTotal += p.approxTotal; hasApprox = true }
  }
  if (!hasApprox || approxTotal <= totalWritten) return null
  const rate = totalWritten / elapsedSec
  if (rate <= 0) return null
  return Math.floor((approxTotal - totalWritten) / rate)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  )
}
