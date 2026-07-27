import { useEffect, useState } from 'react'
import { IconArrowLeft, IconChevronDown, IconPlayerPlay, IconPlayerSkipForward, IconX } from '@tabler/icons-react'
import { getRun, type BackendRun } from '../../services/api-client'
import { resumeFlowRunStep, type FlowRunStep, type FlowRunStepStatus } from '../../services/flow-client'
import { useFlowRunStore } from '../../store/flow-run-store'

const STEP_DOT: Record<FlowRunStepStatus, string> = {
  pending: 'd-idle',
  running: 'd-run',
  paused: 'd-paused',
  succeeded: 'd-done',
  failed: 'd-err',
  skipped: 'd-idle',
  cancelled: 'd-err',
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url.replace(/^https?:\/\/[^/]+/i, '').split('?')[0] || url || 'Request'
  }
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? null, null, 2)
}

interface Props {
  runId: string
  onBack: () => void
}

export function FlowRunView({ runId, onBack }: Props) {
  const run = useFlowRunStore((state) => state.runsById[runId])
  const cancelRun = useFlowRunStore((state) => state.cancelRun)
  const resync = useFlowRunStore((state) => state.resync)
  const [apiRuns, setApiRuns] = useState<Record<string, BackendRun>>({})
  const [actionStep, setActionStep] = useState<string | null>(null)

  useEffect(() => {
    void resync(runId)
  }, [resync, runId])

  useEffect(() => {
    const ids = (run?.steps ?? []).flatMap((step) => step.api_run_id ? [step.api_run_id] : [])
    const missing = ids.filter((id) => !apiRuns[id])
    if (missing.length === 0) return
    let active = true
    void Promise.all(missing.map(async (id) => [id, await getRun(id)] as const))
      .then((items) => {
        if (active) setApiRuns((current) => ({ ...current, ...Object.fromEntries(items) }))
      })
      .catch(() => {
        // The Flow step remains useful even if a historical API run expired.
      })
    return () => {
      active = false
    }
  }, [apiRuns, run?.steps])

  if (!run) return <div className="flow-empty">Loading run…</div>

  const canCancel = run.status === 'queued' || run.status === 'running' || run.status === 'paused'

  async function resolvePaused(step: FlowRunStep, action: 'continue' | 'skip' | 'stop') {
    setActionStep(step.id)
    try {
      await resumeFlowRunStep(run.id, step.id, action)
      await resync(run.id)
    } finally {
      setActionStep(null)
    }
  }

  return (
    <div className="flow-run-view">
      <div className="flow-topbar">
        <div className="flow-topbar-main">
          <button type="button" className="btn" onClick={onBack}><IconArrowLeft size={14} /> Editor</button>
          <span className="flow-name">{run.flow_name_snapshot}</span>
          <span className={`flow-save-state s-${run.status === 'succeeded' ? 'saved' : run.status === 'failed' ? 'error' : 'dirty'}`}>
            {run.status} · {run.current_step}/{run.total_steps}
          </span>
        </div>
        <div className="flow-topbar-actions">
          {canCancel && (
            <button type="button" className="btn btn-danger" onClick={() => void cancelRun(run.id)}>
              <IconX size={14} /> Cancel run
            </button>
          )}
        </div>
      </div>

      <div className="tl flow-run-timeline">
        {(run.steps ?? []).map((step) => {
          const apiRun = step.api_run_id ? apiRuns[step.api_run_id] : undefined
          const statusCode = apiRun?.response_status
          return (
            <div key={step.id} className={`step${step.status === 'paused' ? ' current' : ''}`}>
              <div className={`node ${step.status === 'succeeded' ? 'n-done' : step.status === 'failed' ? 'n-error' : step.status === 'paused' ? 'n-paused' : 'n-idle'}`} />
              <details className={`card flow-run-card${step.status === 'paused' ? ' c-paused' : ''}`} open={step.status === 'paused' || step.status === 'failed'}>
                <summary className="chead flow-run-head">
                  <span className={`sdot ${STEP_DOT[step.status]}`} />
                  <span className={`chip m-${step.request_snapshot.method.toLowerCase()}`}>{step.request_snapshot.method}</span>
                  <span className="clbl">{pathOf(step.request_snapshot.url)}</span>
                  <span className={`flow-run-step-status status-${step.status}`}>{step.status}</span>
                  {statusCode != null && <span className="run-code">{statusCode}</span>}
                  {apiRun?.duration_ms != null && <span className="ct">{apiRun.duration_ms}ms</span>}
                  <IconChevronDown size={13} className="chev" />
                </summary>
                <div className="cbody flow-run-body">
                  <div className="run-section">
                    <div className="rl">Request</div>
                    <div className="flow-run-url">{step.request_snapshot.url}</div>
                    {(step.request_snapshot.headers ?? []).filter((header) => header.enabled).map((header) => (
                      <div className="run-kv" key={header.name}>
                        <span className="run-kv-k">{header.name}</span>
                        <span className="run-kv-v">{header.value}</span>
                      </div>
                    ))}
                    {step.request_snapshot.body && <pre className="run-pre">{step.request_snapshot.body}</pre>}
                  </div>

                  {apiRun && (
                    <div className="run-section">
                      <div className="rl">Response</div>
                      <div className="run-stat-row">
                        <span className={`run-st ${apiRun.status === 'succeeded' ? 'run-st-ok' : 'run-st-err'}`}>{apiRun.status}</span>
                        {statusCode != null && <span className="run-code">{statusCode}</span>}
                        {apiRun.duration_ms != null && <span className="run-dim">{apiRun.duration_ms}ms</span>}
                      </div>
                      <pre className="run-pre">{apiRun.error_message ?? printable(apiRun.response_body)}</pre>
                    </div>
                  )}

                  {step.error_message && <div className="run-error-card">{step.error_message}</div>}
                  {step.status === 'paused' && (
                    <div className="flow-pause-actions">
                      <button type="button" className="btn btn-primary" disabled={actionStep === step.id} onClick={() => void resolvePaused(step, 'continue')}>
                        <IconPlayerPlay size={13} /> Continue
                      </button>
                      <button type="button" className="btn" disabled={actionStep === step.id} onClick={() => void resolvePaused(step, 'skip')}>
                        <IconPlayerSkipForward size={13} /> Skip
                      </button>
                      <button type="button" className="btn btn-danger" disabled={actionStep === step.id} onClick={() => void resolvePaused(step, 'stop')}>
                        <IconX size={13} /> Stop
                      </button>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )
        })}
        {(run.steps ?? []).length === 0 && <div className="flow-empty">Preparing steps…</div>}
      </div>
      {run.error_message && <div className="flow-run-error flow-run-summary">{run.error_message}</div>}
    </div>
  )
}
