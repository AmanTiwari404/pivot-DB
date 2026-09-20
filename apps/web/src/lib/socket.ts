import { io, Socket } from 'socket.io-client'

const BASE = import.meta.env.VITE_API_URL ?? ''

const sockets = new Map<string, Socket>()

export function getMonitorSocket(connectionId: string): Socket {
  const key = `monitor-${connectionId}`
  if (!sockets.has(key)) {
    const socket = io(`${BASE}/monitor/${connectionId}`, {
      path: '/socket.io',
      auth: { token: localStorage.getItem('token') },
      transports: ['websocket'],
    })
    sockets.set(key, socket)
  }
  return sockets.get(key)!
}

export function disconnectSocket(connectionId: string) {
  const key = `monitor-${connectionId}`
  const socket = sockets.get(key)
  if (socket) {
    socket.disconnect()
    sockets.delete(key)
  }
}
