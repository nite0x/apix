import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveRuntimeStatus, useRuntimeStatusStore } from './runtime-status-store'

beforeEach(() => {
  useRuntimeStatusStore.setState({ httpStatus: 'checking', lastCheckedAt: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deriveRuntimeStatus', () => {
  it('is online only when both HTTP and WebSocket are up', () => {
    expect(deriveRuntimeStatus('online', 'connected')).toBe('online')
  })

  it('is degraded when HTTP is up but the socket dropped', () => {
    expect(deriveRuntimeStatus('online', 'disconnected')).toBe('degraded')
  })

  it('is offline when neither is available', () => {
    expect(deriveRuntimeStatus('offline', 'disconnected')).toBe('offline')
  })

  it('is degraded when the socket is up but the health probe failed', () => {
    expect(deriveRuntimeStatus('offline', 'connected')).toBe('degraded')
  })

  it('reports checking while the first probe is in flight', () => {
    expect(deriveRuntimeStatus('checking', 'disconnected')).toBe('checking')
  })
})

describe('checkHealth', () => {
  it('marks the runtime online on a 2xx health response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    await useRuntimeStatusStore.getState().checkHealth()
    expect(useRuntimeStatusStore.getState().httpStatus).toBe('online')
    expect(useRuntimeStatusStore.getState().lastCheckedAt).not.toBeNull()
  })

  it('marks the runtime offline when the probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await useRuntimeStatusStore.getState().checkHealth()
    expect(useRuntimeStatusStore.getState().httpStatus).toBe('offline')
  })
})
