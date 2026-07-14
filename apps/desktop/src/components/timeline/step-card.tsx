import { useEffect, useState } from 'react'
import { IconArrowDownLeft, IconArrowUpRight, IconChevronDown, IconInfoCircle, IconShieldCheck } from '@tabler/icons-react'
import type { Step } from '../../store/session-store'
import { ManualForm } from './manual-form'

interface Props {
  step: Step
  sessionId: string
  defaultOpen?: boolean
  muted?: boolean
  current?: boolean
  onOpenApi?: (step: Step) => void
  onResolvePaused?: (action: 'continue' | 'skip' | 'stop', step: Step, modifiedRequest?: string) => void
}

function MethodChip({ method }: { method: string }) {
  const m = method.toUpperCase()
  const cls = m === 'GET' ? 'm-get' : m === 'POST' ? 'm-post' : m === 'PUT' ? 'm-put' : m === 'DELETE' ? 'm-del' : 'm-get'
  return <span className={`chip ${cls}`}>{m}</span>
}

function StatusCode({ code }: { code: number }) {
  const cls = code < 300 ? 'sc sc-ok' : 'sc sc-err'
  return <span className={cls}>{code}</span>
}

export function StepCard({ step, sessionId, defaultOpen = false, muted = false, current = false, onOpenApi, onResolvePaused }: Props) {
  const [open, setOpen] = useState(defaultOpen || step.status === 'error' || step.status === 'paused')
  const [editingRequest, setEditingRequest] = useState(false)
  const [editedRequest, setEditedRequest] = useState(step.requestBody ?? '')

  useEffect(() => setEditedRequest(step.requestBody ?? ''), [step.requestBody])

  const nodeClass =
    step.type === 'think' ? 'node n-think' :
    step.type === 'manual-input' ? 'node n-manual' :
    step.status === 'paused' ? 'node n-paused' :
    step.status === 'running' ? 'node n-run' :
    step.status === 'done' ? 'node n-ok' :
    step.status === 'error' ? 'node n-err' :
    'node n-idle'

  const cardClass =
    step.type === 'manual-input' ? 'card c-manual' :
    step.status === 'paused' ? 'card c-paused' :
    step.status === 'error' ? 'card c-error' :
    'card'

  if (step.type === 'think') {
    return (
      <div className={`step${muted ? ' muted' : ''}${current ? ' current' : ''}`}>
        <div className={nodeClass} />
        <div className="card">
          <div className="chead" onClick={() => setOpen((o) => !o)}>
            <span className="chip m-think">think</span>
            <span className="clbl-dim">{step.text ?? 'Planning…'}</span>
            {step.text && <IconChevronDown size={13} className={`chev${open ? ' open' : ''}`} />}
          </div>
          {step.text && open && (
            <div className="cbody open">
              <p className="think-p">{step.text}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (step.type === 'manual-input') {
    const hasResponse = step.responseBody != null
    const manualNodeClass =
      step.status === 'running' ? 'node n-run' :
      step.status === 'error' ? 'node n-err' :
      hasResponse ? 'node n-ok' :
      'node n-manual'
    const manualCardClass =
      step.status === 'error' ? 'card c-error' :
      'card c-manual'

    return (
      <div className={`step${muted ? ' muted' : ''}${current ? ' current' : ''}`}>
        <div className={manualNodeClass} />
        <div className={manualCardClass}>
          <div className="chead" onClick={() => setOpen((o) => !o)}>
            {hasResponse && step.method ? (
              <MethodChip method={step.method} />
            ) : (
              <span className="chip m-new">new</span>
            )}
            <span className={hasResponse ? 'clbl' : 'clbl-dim'}>
              {hasResponse ? (step.url ?? '') : 'New request'}
            </span>
            <div className="cr">
              {step.status === 'running' && <span className="ct">···</span>}
              {step.statusCode != null && <StatusCode code={step.statusCode} />}
              {step.durationMs != null && <span className="ct">{step.durationMs}ms</span>}
              <IconChevronDown size={13} className={`chev${open ? ' open' : ''}`} />
            </div>
          </div>
          {open && (
            <div className="cbody open">
              <ManualForm sessionId={sessionId} stepId={step.id} />
              {hasResponse && (
                <>
                  <div className="bl">Response</div>
                  <div className="bc">{step.responseBody}</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // http step
  const hasBody = open && (step.requestBody || step.responseBody || step.extractedVars?.length || step.resolvedVars?.length)

  return (
    <div id={`step-${step.id}`} className={`step${muted ? ' muted' : ''}${current ? ' current' : ''}`}>
      <div className={nodeClass} />
      <div className={cardClass}>
        <div className="chead" onClick={() => setOpen((o) => !o)}>
          {step.method && <MethodChip method={step.method} />}
          <span className="clbl">{step.url ?? ''}</span>
          <div className="cr">
            {onOpenApi && step.method && (
              <button type="button" className="api-link" title="查看接口定义" aria-label="View API definition" onClick={(event) => { event.stopPropagation(); onOpenApi(step) }}>
                <IconInfoCircle size={12} />
              </button>
            )}
            {step.status === 'running' && <span className="ct">···</span>}
            {step.status === 'paused' && <span className="sc sc-wait">paused</span>}
            {step.statusCode != null && <StatusCode code={step.statusCode} />}
            {step.durationMs != null && <span className="ct">{step.durationMs}ms</span>}
            {(step.responseBody || step.requestBody || step.extractedVars?.length || step.resolvedVars?.length) && (
              <IconChevronDown size={13} className={`chev${open ? ' open' : ''}`} />
            )}
          </div>
        </div>

        {hasBody && (
          <div className="cbody open">
            {step.requestBody && (
              <>
                <div className="bl">Request</div>
                <div className="bc">{step.requestBody}</div>
              </>
            )}
            {step.responseBody && (
              <>
                <div className="bl">Response</div>
                <div className="bc">{step.responseBody}</div>
              </>
            )}
            {step.status === 'error' && step.statusCode && (
              <div className="step-error-msg">
                <span>AI stopped — {step.statusCode} {step.statusCode === 403 ? 'Forbidden' : 'Error'}.</span>
              </div>
            )}
            {step.extractedVars?.map((v) => (
              <div key={v.name} className="var-row vr-out">
                <IconArrowUpRight size={12} className="vr-icon" />
                Extracted <code className="var-badge">{v.name}</code> → {v.scope}
              </div>
            ))}
            {step.resolvedVars?.map((v) => (
              <div key={v.name} className="var-row vr-in">
                <IconArrowDownLeft size={12} className="vr-icon" />
                Resolved <code className="var-badge var-badge-in">{v.name}</code> from {v.source ?? v.scope}
              </div>
            ))}
          </div>
        )}

        {step.status === 'paused' && (
          <div className="iv">
            <div className="iv-row">
              <IconShieldCheck size={15} />
              <div className="iv-copy">
                <div className="iv-title">Needs confirmation before reading production users</div>
                <div className="iv-desc">Rule matched <span className="iv-rule">{step.ruleName ?? 'Pause rule'}</span></div>
              </div>
            </div>
            {editingRequest ? (
              <div className="iv-editor">
                <label htmlFor={`edit-${step.id}`}>Edit request before continuing</label>
                <textarea id={`edit-${step.id}`} rows={4} value={editedRequest} onChange={(event) => setEditedRequest(event.target.value)} autoFocus />
                <div className="iv-editor-actions">
                  <button type="button" className="iv-btn iv-send" onClick={() => onResolvePaused?.('continue', step, editedRequest)}>Send changes &amp; continue</button>
                  <button type="button" className="iv-btn iv-skip" onClick={() => setEditingRequest(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="risk-list">
                  <div className="risk-item"><strong>Will happen</strong>{step.riskSummary ?? 'Send this request and continue the flow.'}</div>
                  <div className="risk-item"><strong>Data scope</strong>{step.dataScope ?? 'Uses the active production environment.'}</div>
                </div>
                <div className="iv-acts">
                  <button type="button" className="iv-btn iv-send" onClick={() => onResolvePaused?.('continue', step)}>Send &amp; continue</button>
                  <button type="button" className="iv-btn iv-edit" onClick={() => setEditingRequest(true)}>Edit request</button>
                  <button type="button" className="iv-btn iv-skip" onClick={() => onResolvePaused?.('skip', step)}>Skip step</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
