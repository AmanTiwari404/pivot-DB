import { Leaf, Database, Layers } from 'lucide-react'
import type { DbType } from '../../lib/api'

/**
 * Visual badge for a database engine, used everywhere the app needs to
 * convey "this is a Mongo / PG / MySQL thing" at a glance — connection
 * lists, migration wizards, Saved Jobs rows, the Sync page, etc.
 *
 * Color choice mirrors each engine's own brand identity:
 *   Mongo    — green   (Mongo's leaf logo)
 *   Postgres — blue    (elephant + Postgres docs blue)
 *   MySQL    — orange/teal — we use teal to stay distinct from "warning"
 *
 * `variant`:
 *   chip   — pill with icon + label, default
 *   tag    — small uppercase tag (use in dense tables / option lists)
 *   icon   — icon only, for tight rows
 */
export function EngineBadge({
  engine,
  variant = 'chip',
  className = '',
}: {
  engine: DbType | string
  variant?: 'chip' | 'tag' | 'icon'
  className?: string
}) {
  const cfg = ENGINE_CFG[engine as DbType] ?? FALLBACK
  const Icon = cfg.icon

  if (variant === 'icon') {
    return <Icon className={`h-3.5 w-3.5 ${cfg.text} ${className}`} aria-label={cfg.label} />
  }

  if (variant === 'tag') {
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium ${cfg.bg} ${cfg.text} ${className}`}
      >
        <Icon className="h-2.5 w-2.5" />
        {cfg.label}
      </span>
    )
  }

  // chip
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium ${cfg.bg} ${cfg.text} ${className}`}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  )
}

interface EngineCfg {
  label: string
  icon: typeof Leaf
  bg: string
  text: string
}

const ENGINE_CFG: Record<DbType, EngineCfg> = {
  mongodb:  { label: 'MongoDB',    icon: Leaf,     bg: 'bg-emerald-500/10',  text: 'text-emerald-500' },
  postgres: { label: 'PostgreSQL', icon: Database, bg: 'bg-sky-500/10',      text: 'text-sky-500' },
  mysql:    { label: 'MySQL',      icon: Layers,   bg: 'bg-amber-500/10',    text: 'text-amber-500' },
}
const FALLBACK: EngineCfg = {
  label: 'Unknown',
  icon: Database,
  bg: 'bg-muted',
  text: 'text-muted-foreground',
}
