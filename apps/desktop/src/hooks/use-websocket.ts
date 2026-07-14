import { useEffect, useRef } from 'react'
import {
  mapBackendSession,
  mapBackendStep,
  useSessionStore,
  type BackendSession,
  type BackendStep,
} from '../store/session-store'

const API_BASE = 'http://127.0.0.1:4317/api'
const WS_URL = 'ws://127.0.0.1:4317/ws/logs'

interface RuntimeEvent {
  type: string
  session_id: string
  step_id?: string
  payload?: Record<string, unknown>
}

function upsertStep(sessionId: string, step: ReturnType<typeof mapBackendStep>) {
  const store = useSessionStore.getState()
  const exists = store.sessions.find((session) => session.id === sessionId)?.steps.some((item) => item.id === step.id)
  if (exists) store.updateStep(sessionId, step.id, step)
  else store.addStep(sessionId, step)
}

async function hydrateRun(sessionId: string, stepId: string, runId: string) {
  try {
    const response = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}`)
    if (!response.ok) return
    const run = await response.json() as Record<string, unknown>
    useSessionStore.getState().updateStep(sessionId, stepId, {
      status: run.status === 'succeeded' ? 'done' : 'error',
      statusCode: typeof run.response_status === 'number' ? run.response_status : undefined,
      durationMs: typeof run.duration_ms === 'number' ? run.duration_ms : undefined,
      responseBody:
        typeof run.response_body === 'string'
          ? run.response_body
          : JSON.stringify(run.response_body ?? null, null, 2),
    })
  } catch {
    // The live event remains useful even when run hydration is unavailable.
  }
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let disposed = false

    function connect() {
      if (disposed) return
      try {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onopen = () => useSessionStore.getState().setWsStatus('connected')
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
                store.updateSession(msg.session_id, {
                  status: 'done',
                  summary: msg.payload?.summary as string | undefined,
                })
                break
              case 'session:error':
                store.updateSession(msg.session_id, { status: 'failed' })
                break
              case 'session:stopped':
                store.updateSession(msg.session_id, { status: 'stopped' })
                break
              case 'var:extracted': {
                const current = store.sessions.find((session) => session.id === msg.session_id)
                const variable = msg.payload?.variable as { name?: string; scope?: string; source?: string } | undefined
                if (current && variable) {
                  store.updateSession(msg.session_id, {
                    variables: [
                      ...(current.variables ?? []),
                      {
                        name: variable.name ?? String(msg.payload?.name ?? 'variable'),
                        scope: variable.scope ?? 'session',
                        source: variable.source,
                        valuePreview: '••••••••••••',
                      },
                    ],
                  })
                }
                break
              }
              case 'think:start':
              case 'step:start':
                if (!msg.step_id) break
                upsertStep(msg.session_id, mapBackendStep(msg.payload as unknown as BackendStep))
                break
              case 'step:paused': {
                if (!msg.step_id) break
                const mapped = mapBackendStep(msg.payload as unknown as BackendStep)
                upsertStep(msg.session_id, { ...mapped, status: 'paused' })
                store.updateSession(msg.session_id, {
                  status: 'paused',
                  matchedRule: {
                    id: String(msg.payload?.rule_id ?? mapped.ruleId ?? 'rule'),
                    name: mapped.ruleName ?? 'Matched pause rule',
                    description: 'This request needs manual confirmation before execution.',
                  },
                })
                break
              }
              case 'step:skipped':
                if (!msg.step_id) break
                store.updateStep(msg.session_id, msg.step_id, { status: 'skipped' })
                break
              case 'step:done':
              case 'step:error': {
                if (!msg.step_id) break
                const mapped = mapBackendStep(msg.payload as unknown as BackendStep)
                store.updateStep(msg.session_id, msg.step_id, mapped)
                const output = (msg.payload as BackendStep | undefined)?.output
                const runId = typeof output?.api_run_id === 'string' ? output.api_run_id : undefined
                if (msg.type === 'step:done' && runId) {
                  void hydrateRun(msg.session_id, msg.step_id, runId)
                }
                break
              }
            }
          } catch {
            // Ignore malformed runtime events.
          }
        }

        ws.onclose = () => {
          useSessionStore.getState().setWsStatus('disconnected')
          if (!disposed) timerRef.current = setTimeout(connect, 3000)
        }
        ws.onerror = () => ws.close()
      } catch {
        timerRef.current = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      disposed = true
      wsRef.current?.close()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])
}
