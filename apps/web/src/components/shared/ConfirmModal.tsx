import { useState } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  confirmText?: string
  requireTyped?: string
  destructive?: boolean
  loading?: boolean
}

export function ConfirmModal({
  open, onClose, onConfirm, title, description,
  confirmText = 'Confirm', requireTyped, destructive = false, loading = false,
}: Props) {
  const [typed, setTyped] = useState('')
  if (!open) return null

  const canConfirm = !requireTyped || typed === requireTyped

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-2">{title}</h2>
        <p className="text-sm text-muted-foreground mb-4">{description}</p>
        {requireTyped && (
          <div className="mb-4">
            <p className="text-xs text-muted-foreground mb-1">
              Type <span className="font-mono text-foreground">{requireTyped}</span> to confirm:
            </p>
            <input
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireTyped}
            />
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm || loading}
            className={`px-4 py-2 text-sm rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {loading ? 'Loading…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
