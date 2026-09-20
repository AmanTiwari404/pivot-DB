import { useEffect, useState } from 'react'
import { getMonitorSocket, disconnectSocket } from '../lib/socket'

interface Op {
  opid: string | number
  ns: string
  op: string
  secs_running?: number
  client?: string
  desc?: string
}

export function useCurrentOps(connectionId: string | null) {
  const [ops, setOps] = useState<Op[]>([])

  useEffect(() => {
    if (!connectionId) return
    const socket = getMonitorSocket(connectionId)
    socket.on('currentops', (data: Op[]) => setOps(data))
    return () => {
      socket.off('currentops')
      disconnectSocket(connectionId)
    }
  }, [connectionId])

  return ops
}
