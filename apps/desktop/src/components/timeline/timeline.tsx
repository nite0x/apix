import { IconPlus } from '@tabler/icons-react'
import type { Session } from '../../store/session-store'
import { useSessionStore, type Step } from '../../store/session-store'
import { StepCard } from './step-card'

interface Props {
  session: Session
  onOpenApi: (step: Step) => void
  onAddStep: () => void
  onResolvePaused: (action: 'continue' | 'skip' | 'stop', step: Step, modifiedRequest?: string) => void
}

export function Timeline({ session, onOpenApi, onAddStep, onResolvePaused }: Props) {
  const currentIndex = session.steps.findIndex((step) => step.status === 'paused' || step.status === 'running' || step.status === 'pending')
  const removeStep = useSessionStore((state) => state.removeStep)

  return (
    <div className="tl">
      {session.steps.map((step, i) => (
        <StepCard
          key={step.id}
          step={step}
          sessionId={session.id}
          defaultOpen={step.type === 'manual-input' || step.status === 'paused'}
          muted={currentIndex > 0 && i < currentIndex}
          current={i === currentIndex}
          onOpenApi={onOpenApi}
          onDelete={() => removeStep(session.id, step.id)}
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
      {session.summary && (
        <div className="summary">
          <strong>Done — </strong>{session.summary}
        </div>
      )}
    </div>
  )
}
