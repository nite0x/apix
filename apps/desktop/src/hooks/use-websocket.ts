import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/session-store'
import type { Session, Step } from '../store/session-store'

const WS_URL = 'ws://127.0.0.1:4317/ws/logs'

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const store = useSessionStore.getState()

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
            const msg = JSON.parse(event.data as string) as {
              type: string
              sessionId: string
              stepId?: string
              payload?: Record<string, unknown>
            }
            const s = useSessionStore.getState()

            switch (msg.type) {
              case 'session:start': {
                const p = (msg.payload ?? {}) as Partial<Session>
                s.addSession({
                  id: msg.sessionId,
                  type: 'ai',
                  name: (p.task as string) ?? 'AI session',
                  status: 'running',
                  startedAt: Date.now(),
                  steps: [],
                  source: (p.source as string) ?? 'claude-desktop',
                  task: p.task as string | undefined,
                  environment: p.environment as string | undefined,
                })
                s.setActiveSession(msg.sessionId)
                break
              }
              case 'session:done': {
                const p = (msg.payload ?? {}) as Record<string, unknown>
                s.updateSession(msg.sessionId, {
                  status: 'done',
                  summary: p.summary as string | undefined,
                })
                break
              }
              case 'session:error':
                s.updateSession(msg.sessionId, { status: 'failed' })
                break
              case 'think:start': {
                if (!msg.stepId) break
                const p = (msg.payload ?? {}) as Record<string, unknown>
                s.addStep(msg.sessionId, {
                  id: msg.stepId,
                  type: 'think',
                  status: 'running',
                  text: p.text as string | undefined,
                } as Step)
                break
              }
              case 'step:start': {
                if (!msg.stepId) break
                const p = (msg.payload ?? {}) as Record<string, unknown>
                s.addStep(msg.sessionId, {
                  id: msg.stepId,
                  type: 'http',
                  status: 'running',
                  method: p.method as string | undefined,
                  url: p.url as string | undefined,
                } as Step)
                break
              }
              case 'step:done': {
                if (!msg.stepId) break
                const p = (msg.payload ?? {}) as Record<string, unknown>
                s.updateStep(msg.sessionId, msg.stepId, {
                  status: 'done',
                  statusCode: p.statusCode as number | undefined,
                  durationMs: p.durationMs as number | undefined,
                  responseBody:
                    typeof p.responseBody === 'string'
                      ? p.responseBody
                      : p.responseBody
                        ? JSON.stringify(p.responseBody, null, 2)
                        : undefined,
                })
                break
              }
              case 'step:error': {
                if (!msg.stepId) break
                const p = (msg.payload ?? {}) as Record<string, unknown>
                s.updateStep(msg.sessionId, msg.stepId, {
                  status: 'error',
                  statusCode: p.statusCode as number | undefined,
                  durationMs: p.durationMs as number | undefined,
                  responseBody:
                    typeof p.responseBody === 'string'
                      ? p.responseBody
                      : p.responseBody
                        ? JSON.stringify(p.responseBody, null, 2)
                        : undefined,
                })
                break
              }
            }
          } catch {
            // ignore parse errors
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  void store
}
