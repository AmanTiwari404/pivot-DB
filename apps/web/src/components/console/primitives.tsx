/* Console primitives — buttons, badges, table parts, page chrome.
   Ported from handoff `primitives.jsx`. Pure presentation —
   no API calls, no state beyond hover/focus. */

import React, { useState, type CSSProperties, type ReactNode, type InputHTMLAttributes, type ButtonHTMLAttributes } from 'react'
import { ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react'

/* ---------------- Button ---------------- */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
type ButtonSize = 'sm' | 'md' | 'lg'

const buttonBase: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
  lineHeight: 1, padding: '8px 14px', borderRadius: 'var(--radius)',
  border: '1px solid transparent', cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
  whiteSpace: 'nowrap', userSelect: 'none',
}

const buttonVariants: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: 'var(--accent)', color: 'var(--accent-ink)',
    borderColor: 'var(--accent)',
    boxShadow: '0 1px 0 rgba(20,18,14,0.06), inset 0 1px 0 rgba(255,255,255,0.12)',
  },
  secondary: {
    background: 'var(--surface)', color: 'var(--text-1)',
    borderColor: 'var(--border)', boxShadow: 'var(--shadow-1)',
  },
  ghost: { background: 'transparent', color: 'var(--text-2)', borderColor: 'transparent' },
  destructive: {
    background: 'var(--surface)', color: 'var(--danger)',
    borderColor: 'var(--border)',
  },
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

export function Button({
  variant = 'secondary', size = 'md', icon, children, style, disabled, ...rest
}: ButtonProps) {
  const sz: CSSProperties = size === 'sm'
    ? { padding: '5px 10px', fontSize: 12, borderRadius: 'var(--radius-sm)' }
    : size === 'lg' ? { padding: '10px 18px', fontSize: 14 } : {}
  const v = buttonVariants[variant]
  const [hover, setHover] = useState(false)
  const hoverStyle: CSSProperties = !disabled && hover ? (
    variant === 'primary'     ? { background: 'var(--accent-hover)', borderColor: 'var(--accent-hover)' } :
    variant === 'secondary'   ? { borderColor: 'var(--border-strong)', background: 'var(--rail)' } :
    variant === 'ghost'       ? { background: 'var(--rail)', color: 'var(--text-1)' } :
    variant === 'destructive' ? { borderColor: 'var(--danger)', background: 'var(--danger-soft)' } : {}
  ) : {}
  const disabledStyle: CSSProperties = disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}
  return (
    <button
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{ ...buttonBase, ...v, ...sz, ...hoverStyle, ...disabledStyle, ...style }}
      {...rest}>
      {icon}
      {children}
    </button>
  )
}

/* ---------------- Badge ---------------- */
type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'
export function Badge({
  tone = 'neutral', children, style,
}: { tone?: BadgeTone; children: ReactNode; style?: CSSProperties }) {
  const tones: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
    neutral: { bg: 'var(--rail)',         fg: 'var(--text-2)',  bd: 'var(--border-soft)' },
    accent:  { bg: 'var(--accent-soft)',  fg: 'var(--accent)',  bd: 'var(--accent-soft-2)' },
    success: { bg: 'var(--success-soft)', fg: 'var(--success)', bd: 'var(--success-soft)' },
    warn:    { bg: 'var(--warn-soft)',    fg: 'var(--warn)',    bd: 'var(--warn-soft)' },
    danger:  { bg: 'var(--danger-soft)',  fg: 'var(--danger)',  bd: 'var(--danger-soft)' },
  }
  const t = tones[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 500, lineHeight: 1,
      padding: '3px 7px', borderRadius: 999,
      background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
      ...style,
    }}>{children}</span>
  )
}

/* ---------------- StatusDot ---------------- */
export function StatusDot({ tone = 'success' }: { tone?: 'success' | 'warn' | 'danger' | 'muted' }) {
  const c = tone === 'success' ? 'var(--success)'
          : tone === 'warn'    ? 'var(--warn)'
          : tone === 'danger'  ? 'var(--danger)'
          : 'var(--text-3)'
  return (
    <span style={{
      width: 8, height: 8, borderRadius: 999, background: c, flexShrink: 0,
      boxShadow: `0 0 0 3px ${c}22`,
    }}/>
  )
}

/* ---------------- Card ---------------- */
export function Card({
  children, style, padded = true,
}: { children: ReactNode; style?: CSSProperties; padded?: boolean }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border-soft)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-1)',
      padding: padded ? 20 : 0,
      ...style,
    }}>{children}</div>
  )
}

/* ---------------- SectionLabel ---------------- */
export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 600, color: 'var(--text-3)',
      textTransform: 'uppercase', letterSpacing: '0.08em',
      ...style,
    }}>{children}</div>
  )
}

/* ---------------- TextInput ---------------- */
interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leadingIcon?: ReactNode
  mono?: boolean
  containerStyle?: CSSProperties
}
export function TextInput({
  leadingIcon, mono, containerStyle, style, ...rest
}: TextInputProps) {
  const [focus, setFocus] = useState(false)
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: 'var(--surface)',
      border: `1px solid ${focus ? 'var(--accent)' : 'var(--border)'}`,
      boxShadow: focus ? '0 0 0 3px var(--accent-soft-2)' : 'none',
      borderRadius: 'var(--radius)',
      padding: '6px 10px',
      transition: 'border-color 100ms, box-shadow 100ms',
      ...containerStyle,
    }}>
      {leadingIcon && <span style={{ color: 'var(--text-3)', display: 'inline-flex' }}>{leadingIcon}</span>}
      <input
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{
          border: 'none', outline: 'none', background: 'transparent',
          font: 'inherit', flex: 1, minWidth: 0,
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
          fontSize: mono ? 12 : 13, color: 'var(--text-1)',
          ...style,
        }}
        {...rest}/>
    </div>
  )
}

/* ---------------- Table primitives ---------------- */
type Align = 'left' | 'right' | 'center'
type SortDir = 'asc' | 'desc' | null

export function TH({
  children, align = 'left', sortable, sorted, onClick, style,
}: {
  children: ReactNode; align?: Align; sortable?: boolean; sorted?: SortDir;
  onClick?: () => void; style?: CSSProperties;
}) {
  return (
    <th style={{
      textAlign: align,
      padding: '10px 14px',
      fontSize: 11, fontWeight: 600,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      color: 'var(--text-3)',
      borderBottom: '1px solid var(--border-soft)',
      background: 'var(--surface)',
      cursor: sortable ? 'pointer' : 'default',
      whiteSpace: 'nowrap', userSelect: 'none',
      ...style,
    }} onClick={onClick}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: sorted ? 'var(--text-1)' : 'inherit' }}>
        {children}
        {sortable && (
          sorted === 'asc'  ? <ArrowUp size={11} strokeWidth={2}/> :
          sorted === 'desc' ? <ArrowDown size={11} strokeWidth={2}/> :
                              <ChevronsUpDown size={11} strokeWidth={2} style={{ opacity: 0.5 }}/>
        )}
      </span>
    </th>
  )
}

export function TD({
  children, align = 'left', mono, muted, style,
}: {
  children: ReactNode; align?: Align; mono?: boolean; muted?: boolean; style?: CSSProperties;
}) {
  return (
    <td style={{
      textAlign: align,
      padding: '12px 14px',
      fontSize: 13,
      fontFamily: mono ? 'var(--font-mono)' : 'inherit',
      color: muted ? 'var(--text-3)' : 'var(--text-1)',
      borderBottom: '1px solid var(--border-soft)',
      verticalAlign: 'middle',
      ...style,
    }}>{children}</td>
  )
}

export function TR({
  children, hover = true, style, ...rest
}: { children: ReactNode; hover?: boolean; style?: CSSProperties } & React.HTMLAttributes<HTMLTableRowElement>) {
  const [h, setH] = useState(false)
  return (
    <tr
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: hover && h ? 'var(--rail)' : 'transparent',
        transition: 'background 80ms ease',
        ...style,
      }} {...rest}>{children}</tr>
  )
}

/* ---------------- PageHeader ---------------- */
export function PageHeader({
  title, subtitle, actions,
}: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      padding: '20px 28px 16px',
      borderBottom: '1px solid var(--border-soft)',
      background: 'var(--canvas)',
      gap: 16,
    }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{
          margin: 0, fontSize: 22, fontWeight: 600,
          letterSpacing: '-0.01em', color: 'var(--text-1)',
        }}>{title}</h1>
        {subtitle && <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-3)' }}>{subtitle}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>{actions}</div>
    </div>
  )
}

/* ---------------- Segmented Tabs ---------------- */
export function Tabs<T extends string>({
  tabs, active, onChange, style,
}: { tabs: T[]; active: T; onChange: (v: T) => void; style?: CSSProperties }) {
  return (
    <div style={{
      display: 'inline-flex', gap: 2, padding: 3,
      background: 'var(--rail)', borderRadius: 'var(--radius)',
      border: '1px solid var(--border-soft)',
      ...style,
    }}>
      {tabs.map(t => {
        const on = t === active
        return (
          <button key={t} onClick={() => onChange(t)}
            style={{
              padding: '5px 12px', fontSize: 12, fontWeight: 500,
              borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--text-1)' : 'var(--text-3)',
              boxShadow: on ? 'var(--shadow-1)' : 'none',
              textTransform: 'capitalize',
              transition: 'background 120ms, color 120ms',
              fontFamily: 'inherit',
            }}>{t}</button>
        )
      })}
    </div>
  )
}
