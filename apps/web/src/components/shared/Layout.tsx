import { NavLink } from 'react-router-dom'
import {
  Database, Search, BarChart3, ArrowLeftRight, Shield, Settings as SettingsIcon, LogOut, GitMerge,
  Sun, Moon, Zap,
  type LucideIcon,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../stores/connections.store'
import { api, type AlertRule } from '../../lib/api'
import React, { useState, type CSSProperties } from 'react'
import { useTheme } from '../../hooks/useTheme'

interface NavItem {
  to: string
  icon: LucideIcon
  label: string
}
interface NavGroup { label: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  { label: 'Data', items: [
    { to: '/connections', icon: Database, label: 'Connections' },
    { to: '/explore',     icon: Search,   label: 'Explore' },
  ]},
  { label: 'Operate', items: [
    { to: '/monitor', icon: BarChart3,      label: 'Monitor' },
    { to: '/move',    icon: ArrowLeftRight, label: 'Move' },
    { to: '/migrate', icon: GitMerge,       label: 'Migrate' },
    { to: '/sync',    icon: Zap,            label: 'Sync' },
  ]},
  { label: 'Governance', items: [
    { to: '/protect',  icon: Shield,      label: 'Protect' },
    { to: '/settings', icon: SettingsIcon,label: 'Settings' },
  ]},
]

export function Layout({ children }: { children: React.ReactNode }) {
  const { clearAuth, user, token } = useAuthStore()
  const [theme, , toggleTheme] = useTheme()

  const { data: active } = useQuery({
    queryKey: ['alerts-active'],
    queryFn: () => api.get<{ count: number; rules: AlertRule[] }>('/api/alerts/active'),
    refetchInterval: 30_000,
    enabled: !!token,
  })
  const activeCount = active?.count ?? 0

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--canvas)' }}>
      <Sidebar
        user={user}
        activeCount={activeCount}
        onSignOut={() => {
          clearAuth()
          window.location.href = '/login'
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main style={{ flex: 1, overflow: 'auto' }}>{children}</main>
    </div>
  )
}

/* ---------------- Sidebar ---------------- */
function Sidebar({ user, activeCount, onSignOut, theme, onToggleTheme }: {
  user: { email?: string; role?: string } | null
  activeCount: number
  onSignOut: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  return (
    <aside style={{
      width: 224, flexShrink: 0,
      background: 'var(--rail)',
      borderRight: '1px solid var(--border-soft)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Brand */}
      <div style={{
        height: 56, padding: '0 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--border-soft)',
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: 'var(--accent)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
          flexShrink: 0,
        }}>
          {/* Stylized P with a small rotation arc — the "pivot" mark. */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="PivotDB">
            <path d="M4 3v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M4 3h5a3 3 0 0 1 0 6H4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10.5 11.5a3 3 0 1 1-1-2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.7"/>
            <path d="M10.7 9.5l-1.2 2 0-1.8 1.2-0.2z" fill="currentColor" opacity="0.85"/>
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            PivotDB
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflow: 'auto', padding: '14px 8px' }}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label} style={{ marginBottom: gi < NAV_GROUPS.length - 1 ? 18 : 0 }}>
            <div style={{
              padding: '4px 10px',
              fontSize: 10, fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase', letterSpacing: '0.08em',
            }}>{group.label}</div>
            <div style={{ marginTop: 2 }}>
              {group.items.map(it => (
                <SidebarLink
                  key={it.to}
                  to={it.to}
                  Icon={it.icon}
                  label={it.label}
                  badgeCount={it.label === 'Monitor' ? activeCount : 0}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div style={{
        padding: '12px 14px',
        borderTop: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', gap: 9,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 999,
          background: 'var(--accent-soft-2)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600, flexShrink: 0,
        }}>{user?.email?.[0]?.toUpperCase() ?? 'U'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email ?? 'User'}</div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{user?.role ?? 'viewer'}</div>
        </div>
        <button
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          style={iconBtnSm}
        >
          {theme === 'dark'
            ? <Sun size={13} style={{ color: 'var(--text-3)' }}/>
            : <Moon size={13} style={{ color: 'var(--text-3)' }}/>}
        </button>
        <button onClick={onSignOut} title="Sign out" style={iconBtnSm}>
          <LogOut size={13} style={{ color: 'var(--text-3)' }}/>
        </button>
      </div>
    </aside>
  )
}

const iconBtnSm: CSSProperties = {
  background: 'transparent', border: 'none', padding: 4, borderRadius: 4, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

function SidebarLink({
  to, Icon, label, badgeCount = 0,
}: {
  to: string
  Icon: LucideIcon
  label: string
  badgeCount?: number
}) {
  const [hover, setHover] = useState(false)
  return (
    <NavLink to={to}>
      {({ isActive }) => (
        <div
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          style={{
            position: 'relative',
            width: '100%', textAlign: 'left',
            display: 'flex', alignItems: 'center', gap: 9,
            padding: '6px 10px',
            cursor: 'pointer',
            background: isActive ? 'var(--accent-soft)' : hover ? 'rgba(20,18,14,0.04)' : 'transparent',
            color: isActive ? 'var(--accent)' : 'var(--text-2)',
            fontSize: 13, fontWeight: isActive ? 500 : 400,
            borderRadius: 'var(--radius)',
            transition: 'background 80ms, color 80ms',
          }}>
          {isActive && (
            <span style={{
              position: 'absolute', left: -8, top: 6, bottom: 6,
              width: 2, background: 'var(--accent)', borderRadius: 2,
            }}/>
          )}
          <Icon size={14}/>
          <span style={{ flex: 1 }}>{label}</span>
          {badgeCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              background: 'var(--danger)', color: '#fff',
              padding: '1px 5px', borderRadius: 999,
              minWidth: 16, textAlign: 'center', lineHeight: 1.3,
            }}>{badgeCount > 9 ? '9+' : badgeCount}</span>
          )}
        </div>
      )}
    </NavLink>
  )
}
