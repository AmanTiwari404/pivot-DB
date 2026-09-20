import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, TestTube2, Plus } from 'lucide-react'
import { api, type Connection, type DbType } from '../../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  existing?: Connection
}

/** Per-engine display copy. Keeps the form a single shape across all engines. */
const ENGINE_OPTIONS: Array<{
  value: DbType
  label: string
  uriLabel: string
  uriPlaceholder: string
  hint?: string
}> = [
  {
    value: 'mongodb',
    label: 'MongoDB',
    uriLabel: 'MongoDB URI',
    uriPlaceholder: 'mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority',
  },
  {
    value: 'postgres',
    label: 'PostgreSQL',
    uriLabel: 'Postgres URI',
    uriPlaceholder: 'postgresql://user:pass@host:5432/database?sslmode=require',
    hint: 'Use ?sslmode=require for Supabase, Neon, RDS, and most managed Postgres.',
  },
  {
    value: 'mysql',
    label: 'MySQL',
    uriLabel: 'MySQL URI',
    uriPlaceholder: 'mysql://user:pass@host:3306/database',
  },
]

export function AddConnectionModal({ open, onClose, existing }: Props) {
  const qc = useQueryClient()
  const isEdit = !!existing

  const [dbType, setDbType]     = useState<DbType>(existing?.dbType ?? 'mongodb')
  const [name, setName]         = useState(existing?.name ?? '')
  const [uri, setUri]           = useState('')
  const [tags, setTags]         = useState(existing?.tags.join(', ') ?? '')
  const [readOnly, setReadOnly] = useState(existing?.readOnly ?? false)
  const [createError, setCreateError] = useState<string | null>(null)

  const engine = ENGINE_OPTIONS.find((e) => e.value === dbType)!

  const createMutation = useMutation({
    mutationFn: (data: { name: string; dbType: DbType; uri: string; tags: string[]; readOnly: boolean }) =>
      api.post<Connection>('/api/connections', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
    onError: (err) => setCreateError(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; tags: string[]; readOnly: boolean }) =>
      api.put<Connection>(`/api/connections/${existing!.id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
  })

  const handleSave = () => {
    setCreateError(null)
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    if (isEdit) {
      updateMutation.mutate({ name, tags: tagList, readOnly })
    } else {
      createMutation.mutate({ name, dbType, uri, tags: tagList, readOnly })
    }
  }

  if (!open) return null

  const isPending = createMutation.isPending || updateMutation.isPending
  const error = createError || updateMutation.error?.message

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-lg p-6 w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{isEdit ? 'Edit Connection' : 'Add Connection'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4">
          {/* Engine type — locked on edit (changing dbType post-creation is destructive) */}
          {!isEdit && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Database Type *</label>
              <div className="flex gap-2">
                {ENGINE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDbType(opt.value)}
                    className={`flex-1 px-3 py-2 text-sm rounded border transition-colors ${
                      dbType === opt.value
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Friendly Name *</label>
            <input
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={dbType === 'mongodb' ? 'Production Atlas' : dbType === 'postgres' ? 'Production Postgres' : 'Production MySQL'}
            />
          </div>

          {!isEdit && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{engine.uriLabel} *</label>
              <input
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder={engine.uriPlaceholder}
                type="password"
                spellCheck={false}
                autoComplete="off"
              />
              {engine.hint && (
                <p className="text-xs text-muted-foreground mt-1">{engine.hint}</p>
              )}
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Tags (comma-separated)</label>
            <input
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="production, us-east-1"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="readOnly"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="rounded border-border"
            />
            <label htmlFor="readOnly" className="text-sm text-muted-foreground">Read-only mode</label>
          </div>

          {/* "Test" is folded into Save — the API probes on create and rejects bad URIs. */}
          {!isEdit && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <TestTube2 className="h-3 w-3" />
              Saving will probe the connection — invalid URIs are rejected before the row is created.
            </p>
          )}

          {error && <p className="text-xs text-red-400">{String(error)}</p>}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name || (!isEdit && !uri) || isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            {isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Connection'}
          </button>
        </div>
      </div>
    </div>
  )
}
