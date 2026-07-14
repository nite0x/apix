import { useState } from 'react'
import { IconApi, IconDatabase, IconPlayerPlay, IconPlus, IconSparkles } from '@tabler/icons-react'
import type { Session } from '../../store/session-store'
import { useSessionStore, type Step } from '../../store/session-store'
import { StepCard } from './step-card'

interface Props {
  session: Session
  onOpenApi: (step: Step) => void
  onAddStep: () => void
  onChooseDraftApi: (sessionId: string, stepId: string) => void
  onResolvePaused: (action: 'continue' | 'skip' | 'stop', step: Step, modifiedRequest?: string) => void
}

function DraftStartCard({ session, onChooseApi }: { session: Session; onChooseApi: (sessionId: string, stepId: string) => void }) {
  const configure = useSessionStore((state) => state.configureManualStep)
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const stepId = session.steps[0]?.id

  return (
    <>
      <div className="step blank-flow show">
        <div className="node n-manual" />
        <div className="blank-card">
          <div className="blank-head">
            <IconSparkles size={15} />
            <div><div className="blank-title">New flow</div><div className="blank-sub">Start with a blank request, then APIX will build the run from here.</div></div>
          </div>
          <div className="blank-body">
            <div className="blank-url-row">
              <select className="blank-sel" value={method} onChange={(event) => setMethod(event.target.value)}>{['GET', 'POST', 'PUT', 'DELETE'].map((item) => <option key={item}>{item}</option>)}</select>
              <input className="blank-inp" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://api.example.com/…" autoFocus />
            </div>
            <div className="blank-actions">
              <button type="button" className="blank-primary" disabled={!url.trim() || !stepId} onClick={() => stepId && configure(session.id, stepId, { method, url })}><IconPlayerPlay size={12} /> Start flow</button>
              <button type="button" className="blank-secondary" disabled={!stepId} onClick={() => stepId && onChooseApi(session.id, stepId)}><IconApi size={12} /> Choose API</button>
              <span className="blank-note">This creates a separate flow in Live.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="type-preview show">
        <div className="type-preview-label">Step type examples</div>
        <div className="typed-card">
          <div className="typed-head"><span className="typed-kind kind-api">API</span><div className="typed-title">GET /users?role=admin</div><div className="typed-meta">Production · 284ms</div></div>
          <div className="typed-body">
            <div className="typed-code">GET https://api.example.com/users?role=admin{`\n`}Authorization: Bearer {'{{token}}'}</div>
            <div className="typed-row"><span className="typed-token">{'{{token}}'}</span> resolved from POST /auth/login</div>
            <div className="typed-risk"><strong>API risk</strong>Reads production user data through an authenticated endpoint.</div>
            <div className="typed-result"><span className="typed-pill ok">200</span><span className="typed-pill">342B</span><span className="typed-pill">response preview</span></div>
          </div>
        </div>
        <div className="typed-card typed-disabled">
          <div className="typed-head"><span className="typed-kind kind-sql">SQL</span><div className="typed-title">SQL steps</div><div className="typed-meta"><IconDatabase size={12} /> backend required</div></div>
          <div className="typed-body"><div className="typed-code sql">SELECT id, email, role{`\n`}FROM users{`\n`}WHERE role = 'admin'{`\n`}LIMIT 50;</div></div>
        </div>
      </div>
    </>
  )
}

export function Timeline({ session, onOpenApi, onAddStep, onChooseDraftApi, onResolvePaused }: Props) {
  const currentIndex = session.steps.findIndex((step) => step.status === 'paused' || step.status === 'running' || step.status === 'pending')

  return (
    <div className="tl">
      {session.status === 'draft' ? <DraftStartCard session={session} onChooseApi={onChooseDraftApi} /> : (
        <>
          {session.steps.map((step, i) => (
            <StepCard
              key={step.id}
              step={step}
              sessionId={session.id}
              defaultOpen={step.type === 'manual-input' || step.status === 'paused'}
              muted={currentIndex > 0 && i < currentIndex}
              current={i === currentIndex}
              onOpenApi={onOpenApi}
              onResolvePaused={onResolvePaused}
            />
          ))}
          <div className="step">
            <div className="node n-manual" />
            <button type="button" className="add-step" onClick={onAddStep}>
              <span className="add-step-icon"><IconPlus size={13} /></span>
              <span className="add-step-copy"><span className="add-step-title">Add next step</span><span className="add-step-sub">Choose an API, start from a blank request, or let AI continue from here.</span></span>
              <kbd className="add-step-kbd">N</kbd>
            </button>
          </div>
        </>
      )}
      {session.summary && (
        <div className="summary">
          <strong>Done — </strong>{session.summary}
        </div>
      )}
    </div>
  )
}
