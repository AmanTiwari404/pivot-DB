import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, UserPlus, Plus } from 'lucide-react'
import { api } from '../lib/api'
import { formatDate } from '../lib/utils'
import { useAuthStore } from '../stores/connections.store'

interface AuditEvent { id: string; actor: string; action: string; target: string; timestamp: string }
interface Profile { id: string; name: string; adminId: string; createdAt: string; users: ProfileUser[] }
interface ProfileUser { id: string; email: string; role: string; createdAt: string; lastLoginAt?: string }

export function SettingsPage() {
  const { user } = useAuthStore()
  const [tab, setTab] = useState<'users' | 'audit'>('users')

  const isSuperAdmin = user?.role === 'superadmin'

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <div className="flex gap-1 border-b border-border mb-6">
        {(['users', 'audit'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'users' ? (isSuperAdmin ? 'Admin Profiles' : 'My Workspace') : 'Audit Log'}
          </button>
        ))}
      </div>
      {tab === 'users'
        ? isSuperAdmin ? <SuperAdminTab /> : <AdminTab />
        : <AuditTab />}
    </div>
  )
}

// ── Super Admin: manage admin profiles ────────────────────────────────────────

function SuperAdminTab() {
  const qc = useQueryClient()
  const { data: profiles = [] } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/api/connections/profiles'),
  })

  const [name, setName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/connections/profiles', { name, adminEmail, adminPassword }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      setName(''); setAdminEmail(''); setAdminPassword('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/connections/profiles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  })

  return (
    <div className="space-y-6">
      {/* Create profile form */}
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-4">Create Admin Profile</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Workspace Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice's Workspace"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Admin Email</label>
            <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="admin@company.com"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Admin Password</label>
            <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={!name || !adminEmail || !adminPassword || createMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {createMutation.isPending ? 'Creating…' : 'Create Profile'}
        </button>
        {createMutation.isError && (
          <p className="text-xs text-destructive mt-2">{(createMutation.error as Error).message}</p>
        )}
      </div>

      {/* Profile cards */}
      {profiles.length > 0 && (
        <div className="space-y-4">
          <h2 className="font-semibold">Admin Profiles ({profiles.length})</h2>
          {profiles.map((p) => {
            const admin = p.users.find((u) => u.id === p.adminId)
            const viewers = p.users.filter((u) => u.role === 'viewer')
            return (
              <div key={p.id} className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Admin: {admin?.email ?? '—'} · {viewers.length} viewer{viewers.length !== 1 ? 's' : ''} · Created {formatDate(p.createdAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (confirm(`Delete profile "${p.name}"? This will delete ALL connections and data in this workspace.`))
                        deleteMutation.mutate(p.id)
                    }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {viewers.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {viewers.map((v) => (
                      <span key={v.id} className="text-xs bg-secondary px-2 py-0.5 rounded">{v.email}</span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Admin: manage viewers in own profile ──────────────────────────────────────

function AdminTab() {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const profileId = user?.profileId ?? ''

  const { data: viewers = [] } = useQuery({
    queryKey: ['profile-viewers', profileId],
    queryFn: () => api.get<ProfileUser[]>(`/api/connections/profiles/${profileId}/viewers`),
    enabled: !!profileId,
  })

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const inviteMutation = useMutation({
    mutationFn: () => api.post(`/api/connections/profiles/${profileId}/viewers`, { email, password }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-viewers', profileId] })
      setEmail(''); setPassword('')
    },
  })

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/api/connections/profiles/${profileId}/viewers/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-viewers', profileId] }),
  })

  if (!profileId) {
    return (
      <div className="bg-card border border-border rounded-lg p-5 text-center text-muted-foreground text-sm">
        Your account has no profile assigned. Contact a super admin.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Invite viewer form */}
      <div className="bg-card border border-border rounded-lg p-5">
        <h2 className="font-semibold mb-1">Invite Viewer</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Viewers can read all data in your workspace but cannot create, edit, or delete anything.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="viewer@company.com"
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <button
          onClick={() => inviteMutation.mutate()}
          disabled={!email || !password || inviteMutation.isPending}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded hover:bg-primary/90 disabled:opacity-50"
        >
          <UserPlus className="h-4 w-4" />
          {inviteMutation.isPending ? 'Adding…' : 'Add Viewer'}
        </button>
        {inviteMutation.isError && (
          <p className="text-xs text-destructive mt-2">{(inviteMutation.error as Error).message}</p>
        )}
        {inviteMutation.isSuccess && (
          <p className="text-xs text-green-500 mt-2">Viewer added — share their email and password with them.</p>
        )}
      </div>

      {/* Viewers table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h2 className="font-semibold">Viewers in your workspace ({viewers.length})</h2>
        </div>
        {viewers.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No viewers yet. Add one above.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
                <th className="text-left px-4 py-2">Email</th>
                <th className="text-left px-4 py-2">Added</th>
                <th className="text-left px-4 py-2">Last Login</th>
                <th className="text-right px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {viewers.map((v) => (
                <tr key={v.id} className="border-b border-border/30 hover:bg-secondary/10">
                  <td className="px-4 py-2">{v.email}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(v.createdAt)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {v.lastLoginAt ? formatDate(v.lastLoginAt) : 'Never'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => removeMutation.mutate(v.id)} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Audit log (shared) ────────────────────────────────────────────────────────

function AuditTab() {
  const [page, setPage] = useState(1)
  const [actionFilter, setActionFilter] = useState('')

  const { data } = useQuery({
    queryKey: ['audit', page, actionFilter],
    queryFn: () => api.get<{ events: AuditEvent[]; total: number }>(
      `/api/settings/audit?page=${page}&pageSize=50${actionFilter ? `&action=${actionFilter}` : ''}`
    ),
  })

  const events = data?.events ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / 50)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1) }}
          className="bg-input border border-border rounded px-3 py-2 text-sm">
          <option value="">All actions</option>
          <option value="kill_op">kill_op</option>
          <option value="delete_connection">delete_connection</option>
          <option value="sync_replace">sync_replace</option>
          <option value="restore_backup">restore_backup</option>
          <option value="delete_backup">delete_backup</option>
          <option value="create_migration">create_migration</option>
        </select>
        <span className="text-sm text-muted-foreground">{total.toLocaleString()} events</span>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground uppercase bg-secondary/20">
              <th className="text-left px-4 py-2">Time</th>
              <th className="text-left px-4 py-2">Actor</th>
              <th className="text-left px-4 py-2">Action</th>
              <th className="text-left px-4 py-2">Target</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(e.timestamp)}</td>
                <td className="px-4 py-2 text-xs">{e.actor}</td>
                <td className="px-4 py-2">
                  <span className="bg-secondary text-xs px-1.5 py-0.5 rounded font-mono">{e.action}</span>
                </td>
                <td className="px-4 py-2 text-xs font-mono text-muted-foreground">{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}
            className="text-xs px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-secondary">
            Previous
          </button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}
            className="text-xs px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-secondary">
            Next
          </button>
        </div>
      )}
    </div>
  )
}
