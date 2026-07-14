import { useEffect, useRef } from 'react'
import { useSessionStore, type Session, type SessionStatus, type Step, type StepStatus } from '../store/session-store'

const API_BASE = 'http://127.0.0.1:4317/api'
const WS_URL = 'ws://127.0.0.1:4317/ws/logs'

interface BackendStep {
  id: string
  type?: string
  status?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  thought?: string
  error?: string
  rule_id?: string
  duration_ms?: number
}
interface BackendSession {
  id: string
  type?: string
  status?: string
  task?: string
  source?: string
  steps?: BackendStep[]
  variables?: {
    global?: Record<string, { name?: string; scope?: string; source?: string }>
    session?: Record<string, { name?: string; scope?: string; source?: string }>
  }
  created_at?: string
}

function sessionStatus(value?: string): SessionStatus {
  if (value === 'paused' || value === 'done' || value === 'stopped') return value
  if (value === 'error' || value === 'failed') return 'failed'
  return 'running'
}

function stepStatus(value?: string): StepStatus {
  if (value === 'pending' || value === 'paused' || value === 'done' || value === 'error' || value === 'skipped') return value
  return 'running'
}

function mapStep(step: BackendStep): Step {
  const input = step.input ?? {}
  return {
    id: step.id,
    type: step.type === 'think' ? 'think' : step.type === 'manual' ? 'manual-input' : 'http',
    status: stepStatus(step.status),
    method: typeof input.method === 'string' ? input.method : undefined,
    url: typeof input.url === 'string' ? input.url : undefined,
    text: step.thought,
    ruleId: step.rule_id,
    ruleName: step.rule_id ? `Matched rule ${step.rule_id}` : undefined,
    durationMs: step.duration_ms,
    responseBody: step.error,
  }
}

function mapSession(session: BackendSession): Session {
  const variables = [
    ...Object.values(session.variables?.global ?? {}),
    ...Object.values(session.variables?.session ?? {}),
  ].map((variable) => ({
    name: variable.name ?? 'variable', scope: variable.scope ?? 'session', source: variable.source, valuePreview: '••••••••••••' as string,
  }))
  return {
    id: session.id,
    type: session.type === 'manual' ? 'manual' : 'ai',
    name: session.task ?? 'AI session',
    status: sessionStatus(session.status),
    startedAt: session.created_at ? new Date(session.created_at).getTime() : Date.now(),
    steps: (session.steps ?? []).map(mapStep),
    source: session.source,
    task: session.task,
    environment: 'Production',
    variables,
  }
}

function upsertSession(session: Session) {
  const store = useSessionStore.getState()
  if (store.sessions.some((item) => item.id === session.id)) store.updateSession(session.id, session)
  else store.addSession(session)
}

function upsertStep(sessionId: string, step: Step) {
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
      responseBody: typeof run.response_body === 'string' ? run.response_body : JSON.stringify(run.response_body ?? null, null, 2),
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

    void fetch(`${API_BASE}/sessions`)
      .then((response) => response.ok ? response.json() as Promise<BackendSession[]> : [])
      .then((sessions) => sessions.forEach((session) => upsertSession(mapSession(session))))
      .catch(() => undefined)

    function connect() {
      if (disposed) return
      try {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onopen = () => useSessionStore.getState().setWsStatus('connected')
        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data as string) as {
              type: string
              session_id?: string
              sessionId?: string
              step_id?: string
              stepId?: string
              payload?: Record<string, unknown>
            }
            const sessionId = message.session_id ?? message.sessionId
            const stepId = message.step_id ?? message.stepId
            if (!sessionId) return
            const store = useSessionStore.getState()

            if (message.type === 'session:start') {
              const payload = message.payload as BackendSession | undefined
              upsertSession(mapSession({ ...payload, id: sessionId }))
              store.setActiveSession(sessionId)
              return
            }
            if (message.type === 'session:done') store.updateSession(sessionId, { status: 'done', summary: message.payload?.summary as string | undefined })
            if (message.type === 'session:error') store.updateSession(sessionId, { status: 'failed' })
            if (message.type === 'session:stopped') store.updateSession(sessionId, { status: 'stopped' })
            if (message.type === 'var:extracted') {
              const current = store.sessions.find((session) => session.id === sessionId)
              const variable = message.payload?.variable as { name?: string; scope?: string; source?: string } | undefined
              if (current && variable) store.updateSession(sessionId, { variables: [...(current.variables ?? []), { name: variable.name ?? String(message.payload?.name ?? 'variable'), scope: variable.scope ?? 'session', source: variable.source, valuePreview: '••••••••••••' }] })
            }

            if (!stepId) return
            if (message.type === 'think:start') {
              upsertStep(sessionId, { id: stepId, type: 'think', status: 'running', text: message.payload?.text as string | undefined })
              return
            }

            const payloadStep = (message.payload?.step ?? message.payload ?? {}) as BackendStep
            const mapped = mapStep({ ...payloadStep, id: stepId })
            if (message.type === 'step:start') upsertStep(sessionId, { ...mapped, status: 'running' })
            if (message.type === 'step:paused') {
              upsertStep(sessionId, { ...mapped, status: 'paused', ruleId: String(message.payload?.rule_id ?? mapped.ruleId ?? '') })
              store.updateSession(sessionId, { status: 'paused', matchedRule: { id: String(message.payload?.rule_id ?? 'rule'), name: mapped.ruleName ?? 'Matched pause rule', description: 'This request needs manual confirmation before execution.' } })
            }
            if (message.type === 'step:skipped') store.updateStep(sessionId, stepId, { status: 'skipped' })
            if (message.type === 'step:error') store.updateStep(sessionId, stepId, { ...mapped, status: 'error' })
            if (message.type === 'step:done') {
              store.updateStep(sessionId, stepId, { ...mapped, status: 'done' })
              const output = payloadStep.output
              const runId = typeof output?.api_run_id === 'string' ? output.api_run_id : undefined
              if (runId) void hydrateRun(sessionId, stepId, runId)
            }
          } catch {
            // Ignore malformed events and keep the connection alive.
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
