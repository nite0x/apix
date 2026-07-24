import { create } from 'zustand'
import { checkRuntimeHealth } from '../services/api-client'

export type RuntimeHttpStatus = 'checking' | 'online' | 'offline'
export type WsStatus = 'connected' | 'disconnected'

/**
 * Overall connection status shown to the user. This is a pure global
 * connectivity signal only — it never swallows Catalog/Sessions/Rules/Runs
 * business errors, which keep their own load states.
 */
export type RuntimeStatus = 'checking' | 'online' | 'degraded' | 'offline'

export interface RuntimeStatusStore {
  httpStatus: RuntimeHttpStatus
  lastCheckedAt: number | null
  /** Probe GET /health once. Concurrent calls collapse to the latest result. */
  checkHealth: () => Promise<void>
}

let healthSequence = 0
let inFlight: AbortController | null = null

/**
 * Derives the overall runtime status from the HTTP health probe and the live
 * WebSocket status:
 *   - health 2xx  → HTTP runtime online
 *   - ws connected → realtime events online
 *   - HTTP online but ws down → degraded/reconnecting
 *   - neither available → offline
 */
export function deriveRuntimeStatus(httpStatus: RuntimeHttpStatus, wsStatus: WsStatus): RuntimeStatus {
  if (httpStatus === 'checking') return 'checking'
  if (httpStatus === 'online') return wsStatus === 'connected' ? 'online' : 'degraded'
  // HTTP probe failed. A live socket still means partial connectivity.
  return wsStatus === 'connected' ? 'degraded' : 'offline'
}

export const useRuntimeStatusStore = create<RuntimeStatusStore>((set) => ({
  httpStatus: 'checking',
  lastCheckedAt: null,

  checkHealth: async () => {
    const sequence = ++healthSequence
    // Cancel any older probe so a slow response can't overwrite a newer one.
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    set({ httpStatus: 'checking' })
    const online = await checkRuntimeHealth(controller.signal)
    if (sequence !== healthSequence) return
    inFlight = null
    set({ httpStatus: online ? 'online' : 'offline', lastCheckedAt: Date.now() })
  },
}))

export function runtimeStatusLabel(status: RuntimeStatus): string {
  switch (status) {
    case 'checking':
      return '检查连接…'
    case 'online':
      return 'Runtime 在线'
    case 'degraded':
      return '实时连接中断'
    case 'offline':
      return 'Runtime 离线'
  }
}
