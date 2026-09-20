import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Database } from 'lucide-react'
import { api, type Connection } from '../lib/api'
import { ConnectionCard } from '../components/connections/ConnectionCard'
import { AddConnectionModal } from '../components/connections/AddConnectionModal'

export function ConnectionsPage() {
  const [addOpen, setAddOpen] = useState(false)
  const [editConn, setEditConn] = useState<Connection | null>(null)

  const { data: connections = [], isLoading, error } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<Connection[]>('/api/connections'),
  })

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
            Connections
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-3)' }}>
            Manage your MongoDB, PostgreSQL, and MySQL deployments
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', fontSize: 13, fontWeight: 500,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
            cursor: 'pointer', fontFamily: 'inherit',
            boxShadow: '0 1px 0 rgba(20,18,14,0.06), inset 0 1px 0 rgba(255,255,255,0.12)',
          }}
        >
          <Plus size={14}/>
          Add Connection
        </button>
      </div>

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 192, color: 'var(--text-3)', fontSize: 13 }}>
          Loading connections…
        </div>
      )}

      {error && (
        <div style={{
          background: 'var(--danger-soft)',
          border: '1px solid var(--danger)',
          borderRadius: 'var(--radius)',
          padding: 16, fontSize: 13, color: 'var(--danger)',
        }}>
          {(error as Error).message}
        </div>
      )}

      {!isLoading && connections.length === 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: 256, textAlign: 'center',
        }}>
          <Database size={48} style={{ color: 'var(--text-4)', marginBottom: 16 }}/>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>No connections yet</h3>
          <p style={{ margin: '4px 0 16px', fontSize: 13, color: 'var(--text-3)' }}>
            Add your first database connection to get started.
          </p>
          <button
            onClick={() => setAddOpen(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', fontSize: 13, fontWeight: 500,
              background: 'var(--accent)', color: 'var(--accent-ink)',
              border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <Plus size={14}/>
            Add Connection
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {connections.map((conn) => (
          <ConnectionCard key={conn.id} connection={conn} onEdit={setEditConn}/>
        ))}
      </div>

      <AddConnectionModal open={addOpen} onClose={() => setAddOpen(false)}/>
      {editConn && (
        <AddConnectionModal open onClose={() => setEditConn(null)} existing={editConn}/>
      )}
    </div>
  )
}
