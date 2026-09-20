import { useState } from 'react'
import { useQueryClient, useMutation } from '@tanstack/react-query'
import { Trash2, TestTube2, Edit2, Zap } from 'lucide-react'
import { api, type Connection } from '../../lib/api'
import { ConfirmModal } from '../shared/ConfirmModal'
import { useConnectionsStore } from '../../stores/connections.store'

interface Props {
  connection: Connection
  onEdit: (conn: Connection) => void
}

const topologyTone: Record<string, { bg: string; fg: string; bd: string }> = {
  standalone: { bg: 'var(--rail)',         fg: 'var(--text-2)',  bd: 'var(--border-soft)' },
  replicaSet: { bg: 'var(--accent-soft)',  fg: 'var(--accent)',  bd: 'var(--accent-soft-2)' },
  sharded:    { bg: 'var(--warn-soft)',    fg: 'var(--warn)',    bd: 'var(--warn-soft)' },
}

/** Per-engine pill tone. Distinct from topology so the user can see both at a glance. */
const dbTypeTone: Record<string, { label: string; bg: string; fg: string; bd: string }> = {
  mongodb:  { label: 'Mongo',    bg: '#E6F4EA', fg: '#1F7A3A', bd: '#C8E5D2' },
  postgres: { label: 'Postgres', bg: '#E7EEF8', fg: '#3151A3', bd: '#C9D6EE' },
  mysql:    { label: 'MySQL',    bg: '#FBEEDC', fg: '#9A6300', bd: '#F0D9A8' },
}

export function ConnectionCard({ connection, onEdit }: Props) {
  const qc = useQueryClient()
  const { activeConnectionId, setActiveConnection } = useConnectionsStore()
  const [deleting, setDeleting] = useState(false)
  const [testResult, setTestResult] = useState<{ latencyMs: number; serverVersion: string } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [hover, setHover] = useState(false)

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/connections/${connection.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      if (activeConnectionId === connection.id) setActiveConnection(null)
    },
  })

  const handleTest = async () => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const result = await api.post<{ latencyMs: number; serverVersion: string; topology: string }>(
        `/api/connections/${connection.id}/test`
      )
      setTestResult(result)
    } catch (err) {
      setTestError(String(err))
    } finally {
      setTesting(false)
    }
  }

  const isActive = activeConnectionId === connection.id
  const topology = topologyTone[connection.topology] ?? topologyTone.standalone
  const engineTone = dbTypeTone[connection.dbType] ?? dbTypeTone.mongodb
  // Hide redundant "standalone" topology pill for SQL engines — every SQL conn is standalone.
  const showTopology = connection.dbType === 'mongodb'

  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => setActiveConnection(connection.id)}
        style={{
          background: 'var(--surface)',
          border: `1px solid ${isActive ? 'var(--accent)' : hover ? 'var(--border-strong)' : 'var(--border-soft)'}`,
          boxShadow: isActive
            ? '0 0 0 1px var(--accent), var(--shadow-1)'
            : 'var(--shadow-1)',
          borderRadius: 'var(--radius-lg)',
          padding: 20,
          cursor: 'pointer',
          transition: 'border-color 120ms, box-shadow 120ms',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{
              margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-1)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{connection.name}</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              <span style={{
                fontSize: 11, padding: '2px 7px', borderRadius: 999, fontWeight: 600,
                background: engineTone.bg, color: engineTone.fg,
                border: `1px solid ${engineTone.bd}`,
              }}>
                {engineTone.label}
              </span>
              {showTopology && (
                <span style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 999,
                  background: topology.bg, color: topology.fg,
                  border: `1px solid ${topology.bd}`,
                }}>
                  {connection.topology}
                </span>
              )}
              {connection.readOnly && (
                <span style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 999,
                  background: 'var(--warn-soft)', color: 'var(--warn)',
                  border: '1px solid var(--warn-soft)',
                }}>read-only</span>
              )}
              {connection.tags.map((tag) => (
                <span key={tag} style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 999,
                  background: 'var(--rail)', color: 'var(--text-3)',
                  border: '1px solid var(--border-soft)',
                }}>{tag}</span>
              ))}
            </div>
          </div>
          {isActive && <Zap size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginLeft: 8 }}/>}
        </div>

        {testResult && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--success)' }}>
            {engineTone.label} v{testResult.serverVersion} · {testResult.latencyMs}ms
          </p>
        )}
        {testError && (
          <p style={{
            margin: '0 0 8px', fontSize: 12, color: 'var(--danger)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{testError}</p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            onClick={(e) => { e.stopPropagation(); handleTest() }}
            disabled={testing}
            style={cardActionBtn(testing)}
          >
            <TestTube2 size={12}/>
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(connection) }}
            style={cardActionBtn()}
          >
            <Edit2 size={12}/>
            Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setDeleting(true) }}
            style={{ ...cardActionBtn(), marginLeft: 'auto' }}
          >
            <Trash2 size={12}/>
            Delete
          </button>
        </div>
      </div>

      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => { deleteMutation.mutate(); setDeleting(false) }}
        title="Delete connection"
        description="This will permanently delete the connection and cascade-disable all dependent jobs."
        confirmText="Delete"
        requireTyped={connection.name}
        destructive
        loading={deleteMutation.isPending}
      />
    </>
  )
}

function cardActionBtn(disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 12, padding: '4px 10px',
    background: 'var(--surface)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontFamily: 'inherit',
    transition: 'background 80ms, border-color 80ms, color 80ms',
  }
}
