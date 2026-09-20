import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Skull } from 'lucide-react'
import { api } from '../../lib/api'
import { ConfirmModal } from '../shared/ConfirmModal'

interface Op {
  opid: string | number
  ns: string
  op: string
  secs_running?: number
  client?: string
  desc?: string
}

interface Props {
  ops: Op[]
  connectionId: string
}

export function CurrentOpsTable({ ops, connectionId }: Props) {
  const [killing, setKilling] = useState<Op | null>(null)
  const qc = useQueryClient()

  const killMutation = useMutation({
    mutationFn: (opid: string | number) =>
      api.delete(`/api/connections/${connectionId}/monitor/currentops/${opid}`, { confirmed: true }),
    onSuccess: () => { setKilling(null); qc.invalidateQueries({ queryKey: ['currentops', connectionId] }) },
  })

  if (ops.length === 0) {
    return <p className="text-sm text-muted-foreground">No active operations.</p>
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs uppercase">
              <th className="text-left py-2 pr-4">OpID</th>
              <th className="text-left py-2 pr-4">Namespace</th>
              <th className="text-left py-2 pr-4">Op</th>
              <th className="text-left py-2 pr-4">Duration</th>
              <th className="text-left py-2 pr-4">Client</th>
              <th className="text-right py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {ops.map((op) => (
              <tr key={String(op.opid)} className="border-b border-border/50 hover:bg-secondary/30">
                <td className="py-2 pr-4 font-mono text-xs">{String(op.opid)}</td>
                <td className="py-2 pr-4 text-xs truncate max-w-[160px]">{op.ns ?? '—'}</td>
                <td className="py-2 pr-4">
                  <span className="bg-secondary px-1.5 py-0.5 rounded text-xs">{op.op}</span>
                </td>
                <td className="py-2 pr-4 text-xs">
                  {op.secs_running != null ? `${op.secs_running}s` : '—'}
                </td>
                <td className="py-2 pr-4 text-xs text-muted-foreground">{op.client ?? op.desc ?? '—'}</td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => setKilling(op)}
                    className="text-red-400 hover:text-red-300 transition-colors"
                    title="Kill operation"
                  >
                    <Skull className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={!!killing}
        onClose={() => setKilling(null)}
        onConfirm={() => killing && killMutation.mutate(killing.opid)}
        title="Kill operation"
        description={`Kill op ${killing?.opid} (${killing?.ns ?? 'unknown namespace'})?`}
        confirmText="Kill Op"
        destructive
        loading={killMutation.isPending}
      />
    </>
  )
}
