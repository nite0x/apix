import { useEffect, useRef } from 'react'
import {
  mapBackendSession,
  mapBackendStep,
  useSessionStore,
  type BackendSession,
  type BackendStep,
} from '../store/session-store'
import { useCatalogStore } from '../store/catalog-store'
import { useRunHistoryStore } from '../store/run-history-store'
import { useRuntimeStatusStore } from '../store/runtime-status-store'
import { useFlowStore } from '../store/flow-store'
import { useFlowRunStore } from '../store/flow-run-store'

const API_BASE = 'http://127.0.0.1:4317/api'
const WS_URL = 'ws://127.0.0.1:4317/ws/logs'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const RUN_REFRESH_DEBOUNCE_MS = 400

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
  const attemptsRef = useRef(0)
  const runRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let disposed = false

    // Coalesce run-history refreshes so a burst of events triggers one reload,
    // and only when the history has actually been opened at least once.
    function scheduleRunRefresh() {
      if (runRefreshTimerRef.current) return
      runRefreshTimerRef.current = setTimeout(() => {
        runRefreshTimerRef.current = null
        if (!disposed) useRunHistoryStore.getState().refreshIfLoaded()
      }, RUN_REFRESH_DEBOUNCE_MS)
    }

    // After the socket (re)connects, resync the data that may have changed while
    // it was down. The stores each guard against stale/duplicate responses.
    function resyncOnOpen() {
      void useSessionStore.getState().loadSessions()
      void useCatalogStore.getState().refresh()
      void useRuntimeStatusStore.getState().checkHealth()
      useRunHistoryStore.getState().refreshIfLoaded()
      void useFlowStore.getState().loadFlows()
      // A dropped socket may have missed run events; re-sync the open run.
      const activeRunId = useFlowRunStore.getState().activeRunId
      if (activeRunId) void useFlowRunStore.getState().resync(activeRunId)
    }

    function scheduleReconnect() {
      if (disposed || timerRef.current) return
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptsRef.current, RECONNECT_MAX_MS)
      attemptsRef.current += 1
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        connect()
      }, delay)
    }

    function connect() {
      if (disposed) return
      // Never create a second parallel socket.
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return
      try {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onopen = () => {
          if (disposed) { ws.close(); return }
          attemptsRef.current = 0
          useSessionStore.getState().setWsStatus('connected')
          resyncOnOpen()
        }
        ws.onmessage = (event) => {
          if (disposed) return
          try {
            const msg = JSON.parse(event.data as string) as RuntimeEvent
            // Flow run events route to the flow-run store only; they must never
            // be pushed back into the legacy session store.
            if (msg.type.startsWith('flow_run.')) {
              useFlowRunStore.getState().applyEvent(msg)
              return
            }
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
                scheduleRunRefresh()
                break
              case 'session:error':
                store.updateSession(msg.session_id, { status: 'failed' })
                scheduleRunRefresh()
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
                scheduleRunRefresh()
                break
              }
            }
          } catch {
            // Ignore malformed runtime events.
          }
        }

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null
          if (disposed) return
          useSessionStore.getState().setWsStatus('disconnected')
          // A dropped socket means realtime is down; refresh the HTTP health signal.
          void useRuntimeStatusStore.getState().checkHealth()
          scheduleReconnect()
        }
        ws.onerror = () => ws.close()
      } catch {
        scheduleReconnect()
      }
    }

    connect()
    return () => {
      disposed = true
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
        ws.close()
      }
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      if (runRefreshTimerRef.current) { clearTimeout(runRefreshTimerRef.current); runRefreshTimerRef.current = null }
    }
  }, [])
}
