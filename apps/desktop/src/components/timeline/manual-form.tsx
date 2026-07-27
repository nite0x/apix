import { useState } from 'react'
import type { RequestData } from '../../data/api-catalog'
import type { BackendRun } from '../../services/api-client'
import { useSessionStore } from '../../store/session-store'
import { RequestWorkbench } from '../request/request-workbench'

interface Props {
  sessionId: string
  stepId: string
}

export function ManualForm({ sessionId, stepId }: Props) {
  const initialStep = useSessionStore((state) =>
    state.sessions.find((session) => session.id === sessionId)?.steps.find((step) => step.id === stepId),
  )
  const [request, setRequest] = useState<RequestData>(() => ({
    method: initialStep?.method ?? 'GET',
    url: initialStep?.url ?? '',
    query_params: [],
    headers: [],
    body_type: initialStep?.requestBody ? 'json' : 'none',
    body: initialStep?.requestBody ?? '',
  }))
  const store = useSessionStore()
  const hasSent = initialStep?.responseBody != null

  function handleChange(next: RequestData) {
    setRequest(next)
    store.updateStep(sessionId, stepId, {
      method: next.method,
      url: next.url,
      requestBody: next.method !== 'GET' ? next.body : undefined,
    })
  }

  function handleRun(run: BackendRun) {
    store.updateStep(sessionId, stepId, {
      status: run.status === 'succeeded' ? 'done' : 'error',
      method: request.method,
      url: request.url,
      requestBody: request.method !== 'GET' ? request.body : undefined,
      statusCode: run.response_status,
      durationMs: run.duration_ms,
      responseBody: run.error_message ?? (typeof run.response_body === 'string'
        ? run.response_body
        : JSON.stringify(run.response_body ?? null, null, 2)),
    })
    store.updateSession(sessionId, {
      name: `${request.method} ${request.url.replace(/^https?:\/\/[^/]+/, '')}`,
      status: 'idle',
    })
  }

  return (
    <RequestWorkbench
      request={request}
      sourceApiRequestId={initialStep?.apiRequestId}
      onChange={handleChange}
      onRunResult={handleRun}
      hasSent={hasSent}
    />
  )
}
