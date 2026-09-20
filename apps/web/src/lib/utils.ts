import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(date))
}

export function humanCron(expr: string): string {
  const parts = expr.trim().split(' ')
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const pad = (n: string) => n.padStart(2, '0')

  // Every N minutes: */N * * * *
  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `Every ${min.slice(2)} minutes`

  // Every hour at minute N: N * * * *
  if (!min.startsWith('*') && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `Every hour at :${pad(min)}`

  // Every day: M H * * *
  if (dom === '*' && month === '*' && dow === '*')
    return `Every day at ${pad(hour)}:${pad(min)}`

  // Weekly: M H * * D
  if (dom === '*' && month === '*' && dow !== '*')
    return `Every ${days[+dow] ?? dow} at ${pad(hour)}:${pad(min)}`

  // Monthly: M H D * *
  if (dom !== '*' && month === '*' && dow === '*')
    return `Every month on day ${dom} at ${pad(hour)}:${pad(min)}`

  return expr
}
