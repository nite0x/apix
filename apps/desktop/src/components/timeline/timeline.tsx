import type { Session } from '../../store/session-store'
import { StepCard } from './step-card'

interface Props {
  session: Session
}

export function Timeline({ session }: Props) {
  return (
    <div className="tl">
      {session.steps.map((step, i) => (
        <StepCard
          key={step.id}
          step={step}
          sessionId={session.id}
          defaultOpen={step.type === 'manual-input' || (step.type === 'http' && i === 1 && session.type === 'ai')}
        />
      ))}
      {session.summary && (
        <div className="summary">
          <strong>Done — </strong>{session.summary}
        </div>
      )}
    </div>
  )
}
