import { useEffect, useRef } from 'react'
import {
  mapBackendSession,
  mapBackendStep,
  useSessionStore,
  type BackendSession,
  type BackendStep,
} from '../store/session-store'

const WS_URL = 'ws://127.0.0.1:4317/ws/logs'

interface RuntimeEvent {
  type: string
  session_id: string
  step_id?: string
  payload?: Record<string, unknown>
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function connect() {
      try {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onopen = () => {
          useSessionStore.getState().setWsStatus('connected')
        }

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as RuntimeEvent
            const store = useSessionStore.getState()

            switch (msg.type) {
              case 'session:start': {
                const session = mapBackendSession(msg.payload as unknown as BackendSession)
                store.addSession(session)
                store.setActiveSession(session.id)
                break
              }
              case 'session:done':
                store.updateSession(msg.session_id, { status: 'done' })
                break
              case 'session:error':
              case 'session:stopped':
                store.updateSession(msg.session_id, { status: 'failed' })
                break
              case 'think:start':
              case 'step:start':
                if (!msg.step_id) break
                store.addStep(msg.session_id, mapBackendStep(msg.payload as unknown as BackendStep))
                break
              case 'step:done':
              case 'step:error':
                if (!msg.step_id) break
                store.updateStep(msg.session_id, msg.step_id, mapBackendStep(msg.payload as unknown as BackendStep))
                break
            }
          } catch {
            // Ignore malformed runtime events.
          }
        }

        ws.onclose = () => {
          useSessionStore.getState().setWsStatus('disconnected')
          timerRef.current = setTimeout(connect, 3000)
        }

        ws.onerror = () => {
          ws.close()
        }
      } catch {
        timerRef.current = setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      wsRef.current?.close()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])
}
