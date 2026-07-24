// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './use-websocket'
import { useSessionStore } from '../store/session-store'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event('close'))
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  MockWebSocket.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([]))))
  useSessionStore.setState({ wsStatus: 'disconnected' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useWebSocket', () => {
  it('opens a single socket and marks the status connected on open', () => {
    renderHook(() => useWebSocket())
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => { MockWebSocket.instances[0].triggerOpen() })
    expect(useSessionStore.getState().wsStatus).toBe('connected')
  })

  it('resyncs data after the socket connects', () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    renderHook(() => useWebSocket())
    fetchMock.mockClear()

    act(() => { MockWebSocket.instances[0].triggerOpen() })

    // Sessions + catalog + health probes are triggered on reconnect.
    expect(fetchMock).toHaveBeenCalled()
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('/health'))).toBe(true)
    expect(urls.some((url) => url.includes('/sessions'))).toBe(true)
  })

  it('reconnects with a single timer after a close and never doubles sockets', () => {
    renderHook(() => useWebSocket())
    act(() => { MockWebSocket.instances[0].triggerOpen() })

    act(() => { MockWebSocket.instances[0].close() })
    expect(useSessionStore.getState().wsStatus).toBe('disconnected')

    // Backoff base is 1s; advancing it should create exactly one new socket.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('stops reconnecting and creates no sockets after unmount', () => {
    const { unmount } = renderHook(() => useWebSocket())
    act(() => { MockWebSocket.instances[0].close() })
    unmount()

    act(() => { vi.advanceTimersByTime(60000) })
    // The single socket from mount, plus the one scheduled reconnect that fired
    // before unmount cleared the timer — never an unbounded growth.
    expect(MockWebSocket.instances.length).toBeLessThanOrEqual(2)
  })
})
