import { useEffect, useState, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import type {
  MigrationProgressTick, MigrationPhase, SchemaWarning,
} from '../lib/api'

const BASE = import.meta.env.VITE_API_URL ?? ''

/**
 * Per-namespace progress map keyed by "db.collection" (the same key the
 * server uses when emitting). Phase is derived from the latest tick.
 */
export type ProgressMap = Record<string, MigrationProgressTick>

export interface MigrationSocketState {
  /** Last phase event from the server. null until the run starts emitting. */
  phase: MigrationPhase | null
  progress: ProgressMap
  warnings: SchemaWarning[]
  /** Final summary attached to the last "phase" event when run completes. */
  summary?: {
    namespaces: number
    succeeded: number
    failed: number
    totalWritten: number
    totalSkipped: number
    totalFailed: number
  }
  error?: string
  connected: boolean
}

/**
 * Subscribe to `/migration-v2` and join the runId room. Returns the
 * accumulated state from live socket events.
 *
 * Disconnects + cleans up on unmount or runId change.
 */
export function useMigrationSocket(runId: string | null): MigrationSocketState {
  const [state, setState] = useState<MigrationSocketState>(() => initialState())
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!runId) {
      setState(initialState())
      return
    }

    // Reset state for a new run.
    setState(initialState())

    const socket = io(`${BASE}/migration-v2`, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      // Keep trying — migrations can outlive transient WS drops.
      reconnection: true,
      reconnectionAttempts: 30,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setState((s) => ({ ...s, connected: true }))
      socket.emit('subscribe', runId)
    })

    socket.on('disconnect', () => {
      setState((s) => ({ ...s, connected: false }))
    })

    socket.on('progress', (tick: MigrationProgressTick & { key: string }) => {
      setState((s) => ({
        ...s,
        progress: { ...s.progress, [tick.key]: tick },
      }))
    })

    socket.on('warning', (w: SchemaWarning) => {
      setState((s) => ({ ...s, warnings: [...s.warnings, w] }))
    })

    socket.on('phase', (p: { phase: MigrationPhase; summary?: MigrationSocketState['summary']; error?: string }) => {
      setState((s) => ({ ...s, phase: p.phase, summary: p.summary, error: p.error }))
    })

    return () => {
      socket.emit('unsubscribe', runId)
      socket.disconnect()
      socketRef.current = null
    }
  }, [runId])

  return state
}

function initialState(): MigrationSocketState {
  return {
    phase: null,
    progress: {},
    warnings: [],
    connected: false,
  }
}
