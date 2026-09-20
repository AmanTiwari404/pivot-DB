const colors: Record<string, string> = {
  pending:  'bg-yellow-500/10 text-yellow-400',
  running:  'bg-blue-500/10 text-blue-400',
  done:     'bg-green-500/10 text-green-400',
  success:  'bg-green-500/10 text-green-400',
  failed:   'bg-red-500/10 text-red-400',
  partial:  'bg-orange-500/10 text-orange-400',
}

export function JobStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status}
    </span>
  )
}
