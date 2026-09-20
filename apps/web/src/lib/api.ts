const BASE = import.meta.env.VITE_API_URL ?? ''

function getToken(): string | null {
  return localStorage.getItem('token')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const hasBody = init.body !== undefined && init.body !== null
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 401) {
    localStorage.removeItem('token')
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
    throw new Error(err.error ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get:    <T>(path: string) => request<T>(path),
  post:   <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST',  ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  put:    <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT',   ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  patch:  <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
}

// Auth helpers
type AuthResponse = { token: string; user: { id: string; email: string; role: string; profileId: string | null } }

export async function login(email: string, password: string) {
  const res = await api.post<AuthResponse>('/api/connections/auth/login', { email, password })
  localStorage.setItem('token', res.token)
  return res
}

/** Only succeeds once — creates the first superadmin. 403s after that. */
export async function register(email: string, password: string) {
  const res = await api.post<AuthResponse>('/api/connections/auth/register', { email, password })
  localStorage.setItem('token', res.token)
  return res
}

export function getAuthStatus() {
  return api.get<{ needsSetup: boolean }>('/api/connections/auth/status')
}

// Connection types
export type DbType = 'mongodb' | 'postgres' | 'mysql'

export interface Connection {
  id: string
  name: string
  /** Engine type. Defaults to 'mongodb' for rows created before cross-engine support. */
  dbType: DbType
  /** Mongo-only: standalone | replicaSet | sharded. "standalone" for SQL. */
  topology: string
  /** Server version cached at last successful test, e.g. "7.0.5" or "16.2". */
  dbVersion?: string | null
  /** Per-engine extras (PG schemas, MySQL charset, Mongo replicaSet name). */
  metadata?: Record<string, unknown> | null
  tags: string[]
  readOnly: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ExportJob {
  id: string
  connectionId: string
  exportType?: string
  database: string
  collection: string | null
  format: string
  status: string
  fileKey?: string
  createdAt: string
}

// ─── Phase 4: CDC sync (continuous replication) ─────────────────────────────
/** queued | bootstrapping | tailing | paused | failed */
export type CdcSyncStatus = 'queued' | 'bootstrapping' | 'tailing' | 'paused' | 'failed'

export interface CdcSyncRun {
  id: string
  jobId: string
  phase: string
  startedAt: string
  finishedAt: string | null
  inserts: number
  updates: number
  deletes: number
  errorsCount: number
  lastError: string | null
}

export interface CdcSyncJob {
  id: string
  name: string
  sourceConnId: string
  destConnId: string
  sourceType: DbType
  destType: DbType
  sourceDatabase: string | null
  destDatabase: string | null
  namespaces: Array<{ database: string; name: string }> | null
  bootstrap: 'snapshot' | 'tail'
  status: CdcSyncStatus
  lastEventAt: string | null
  lastError: string | null
  pauseRequested: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
  /** Included by GET endpoints. */
  source?: { id: string; name: string; dbType: DbType }
  destination?: { id: string; name: string; dbType: DbType }
  runs?: CdcSyncRun[]
}

export interface CreateCdcSyncBody {
  name: string
  sourceConnId: string
  destConnId: string
  sourceDatabase?: string
  destDatabase?: string
  namespaces?: Array<{ database: string; name: string }>
  bootstrap?: 'snapshot' | 'tail'
}

export interface BackupJob {
  id: string
  name: string
  connectionId: string
  connection?: { name: string }
  databases: string[]
  schedule: string
  retentionDays: number
  status: string         // active | paused
  lastRunAt?: string
  lastRunStatus?: string // success | failed | running
  lastRunError?: string
  createdAt: string
  updatedAt: string
}

export interface BackupRun {
  id: string
  jobId: string
  status: string         // running | success | failed
  startedAt: string
  finishedAt?: string
  sizeBytes?: number
  filePath?: string
  databases: string[]
  errorMsg?: string
}

export interface MonitorSnapshot {
  host: string
  version: string
  uptime: number
  storageEngine: string
  currentConnections: number
  availableConnections: number
  totalConnectionsCreated: number
  opsPerSec: {
    insert: number; query: number; update: number;
    delete: number; getmore: number; command: number
  }
  memResident: number
  memVirtual: number
  networkBytesIn: number
  networkBytesOut: number
  networkRequests: number
  wtCacheUsedMB: number
  wtCacheMaxMB: number
  wtCacheHitRatio: number
  docsRead: number
  docsInserted: number
  docsUpdated: number
  docsDeleted: number
  replicaSet: {
    name: string
    myState: number
    myStateName: string
    members: Array<{
      name: string
      state: number
      stateName: string
      health: number
      lagSeconds: number | null
      self?: boolean
    }>
  } | null
  activeAlerts: number
  timestamp: string
}

export interface CurrentOp {
  opid: string | number
  type: string
  ns: string
  op: string
  durationMs: number
  client: string
  desc: string
  waitingForLock: boolean
  query?: Record<string, unknown>
  planSummary?: string
}

export interface SlowQuery {
  op: string
  ns: string
  durationMs: number
  keysExamined: number
  docsExamined: number
  docsReturned: number
  query: Record<string, unknown>
  planSummary: string
  ts: string
}

export interface DbSize {
  db: string
  sizeOnDisk: number
  collections: number
  objects: number
  dataSize: number
  indexSize: number
  storageSize: number
}

export interface CollSize {
  name: string
  count: number
  size: number
  avgObjSize: number
  storageSize: number
  totalIndexSize: number
  nindexes: number
}

export interface RestoreRun {
  id: string
  backupRunId: string
  targetConnectionId: string
  profileId: string
  status: string                 // queued | running | success | failed
  startedAt?: string
  finishedAt?: string
  log?: string
  createdAt: string
  backupRun?: {
    id: string
    startedAt: string
    sizeBytes?: number
    jobId?: string
    job?: { id: string; name: string }
  }
  targetConnection?: { id: string; name: string }
}

export interface MigrationJob {
  id: string
  name: string
  sourceConnId: string
  destConnId: string
  scope: unknown
  options: unknown
  status: string
  createdBy: string
  createdAt: string
  source?: { name: string }
  destination?: { name: string }
  runs?: MigrationRun[]
}

export interface MigrationRun {
  id: string
  jobId: string
  startedAt: string
  finishedAt?: string
  status: string
  phase?: string
  logLines: string[]
  errorReport?: unknown
}

export type AlertMetric =
  | 'currentConnections' | 'availableConnections'
  | 'memResident' | 'memVirtual'
  | 'opsPerSecTotal' | 'replicationLag' | 'wtCachePercent'
  | 'networkBytesIn' | 'networkBytesOut'

export type AlertCondition = 'gt' | 'lt' | 'gte' | 'lte'

export interface AlertRule {
  id: string
  profileId: string
  connectionId: string
  name: string
  metric: AlertMetric
  condition: AlertCondition
  threshold: number
  durationMinutes: number
  enabled: boolean
  notifyEmail: string | null
  notifyWebhook: string | null
  status: 'ok' | 'firing' | 'paused'
  firingStartedAt: string | null
  lastEvaluatedAt: string | null
  lastNotifiedAt: string | null
  createdAt: string
  updatedAt: string
  // Augmented by GET /api/alerts/rules:
  latestEvent?: AlertEvent | null
  eventCount?: number
  // Augmented by GET /api/alerts/active:
  connection?: { id: string; name: string }
}

export interface AlertEvent {
  id: string
  ruleId: string
  profileId: string
  connectionId: string
  metric: AlertMetric
  value: number
  threshold: number
  condition: AlertCondition
  status: 'firing' | 'resolved' | 'acknowledged'
  firedAt: string
  resolvedAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  note: string | null
  notified: boolean
  rule?: { id: string; name: string; metric: AlertMetric }
}

export interface SavedQuery {
  id: string
  name: string
  database: string
  collection: string
  query: unknown
  isPipeline: boolean
  createdAt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-engine migration v2 (Phase 1C+)
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical type tokens emitted by the inference layer. */
export type CanonicalType =
  | 'string' | 'int' | 'long' | 'float' | 'double' | 'decimal'
  | 'boolean' | 'date' | 'timestamp' | 'time' | 'binary' | 'uuid'
  | 'objectid' | 'json' | 'jsonb' | 'array'
  | 'mixed' | 'null' | 'unknown'

export interface NamespaceRef { database: string; name: string }

export interface InferredColumn {
  name: string
  type: CanonicalType
  nullable: boolean
  primaryKey?: boolean
  references?: string
  presenceCount?: number
  observedTypes?: CanonicalType[]
}

export interface InferredSchema {
  namespace: NamespaceRef
  approxCount?: number
  columns: InferredColumn[]
  warnings: SchemaWarning[]
}

export interface SchemaWarning {
  namespace: NamespaceRef
  column?: string
  severity: 'info' | 'warn' | 'error'
  code: string
  message: string
}

export interface PreviewResponse {
  schemas: InferredSchema[]
  warnings: SchemaWarning[]
  ddl: string[]
}

export interface MigrationV2Job {
  id: string
  name: string
  profileId: string
  sourceConnId: string
  destConnId: string
  sourceType: DbType
  destType: DbType
  sourceDatabase: string | null
  destDatabase: string | null
  sampleSize: number
  batchSize: number
  parallelism: number
  dropExisting: boolean
  failOnTypeConflict: boolean
  createdBy: string
  createdAt: string
  source?: { id: string; name: string; dbType: DbType }
  destination?: { id: string; name: string; dbType: DbType }
  runs?: MigrationV2Run[]
}

export type MigrationPhase =
  | 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export interface MigrationProgressTick {
  namespace: NamespaceRef
  phase: 'inferring' | 'initialising' | 'streaming' | 'finalising' | 'done' | 'failed'
  written: number
  skipped: number
  failed: number
  approxTotal?: number
  error?: string
}

export interface MigrationV2Run {
  id: string
  jobId: string
  profileId: string
  phase: MigrationPhase
  cancelRequested: boolean
  dryRun: boolean
  startedAt: string | null
  finishedAt: string | null
  totalNamespaces: number
  succeededNs: number
  failedNs: number
  totalWritten: number
  totalSkipped: number
  totalFailed: number
  progress: Record<string, MigrationProgressTick> | null
  warnings: SchemaWarning[] | null
  errors: Array<{ namespace: NamespaceRef | null; error: string }> | null
  ddlPreview: string | null
  createdAt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL monitor snapshot (Phase 2B)
// ─────────────────────────────────────────────────────────────────────────────

export interface SqlMonitorSnapshot {
  version: string
  uptimeSeconds: number
  currentDatabase: string

  connections: {
    current: number
    max: number | null
    active: number
    idle: number
  }

  throughput: {
    transactionsPerSec: number | null
    queriesPerSec: number | null
    cacheHitRatio: number | null
  }

  topTables: Array<{
    schema: string
    name: string
    sizeBytes: number
    rowCount: number
  }>

  activeQueries: Array<{
    pid: string
    user: string
    database: string
    state: string
    durationMs: number
    query: string
  }>

  replication: {
    isReplica: boolean
    lagSeconds: number | null
  } | null
}
