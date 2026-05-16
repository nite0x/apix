import { useState } from 'react'
import { IconChevronDown, IconArrowUpRight } from '@tabler/icons-react'
import type { Step } from '../../store/session-store'
import { ManualForm } from './manual-form'

interface Props {
  step: Step
  sessionId: string
  defaultOpen?: boolean
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

export function StepCard({ step, sessionId, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen || step.status === 'error')

  const nodeClass =
    step.type === 'think' ? 'node n-think' :
    step.type === 'manual-input' ? 'node n-manual' :
    step.status === 'running' ? 'node n-run' :
    step.status === 'done' ? 'node n-ok' :
    step.status === 'error' ? 'node n-err' :
    'node n-idle'

  const cardClass =
    step.type === 'manual-input' ? 'card c-manual' :
    step.status === 'error' ? 'card c-error' :
    'card'

  if (step.type === 'think') {
    return (
      <div className="step">
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
    return (
      <div className="step">
        <div className={nodeClass} />
        <div className={cardClass}>
          <div className="chead" onClick={() => setOpen((o) => !o)}>
            <span className="chip m-new">new</span>
            <span className="clbl-dim">New request</span>
            <IconChevronDown size={13} className={`chev${open ? ' open' : ''}`} />
          </div>
          {open && (
            <div className="cbody open">
              <ManualForm sessionId={sessionId} stepId={step.id} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // http step
  const hasBody = open && (step.requestBody || step.responseBody || step.extractedVars?.length)

  return (
    <div className="step">
      <div className={nodeClass} />
      <div className={cardClass}>
        <div className="chead" onClick={() => setOpen((o) => !o)}>
          {step.method && <MethodChip method={step.method} />}
          <span className="clbl">{step.url ?? ''}</span>
          <div className="cr">
            {step.status === 'running' && <span className="ct">···</span>}
            {step.statusCode != null && <StatusCode code={step.statusCode} />}
            {step.durationMs != null && <span className="ct">{step.durationMs}ms</span>}
            {(step.responseBody || step.requestBody || step.extractedVars?.length) && (
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
          </div>
        )}
      </div>
    </div>
  )
}
