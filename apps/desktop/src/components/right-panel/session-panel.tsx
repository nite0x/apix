import { IconInfoCircle } from '@tabler/icons-react'
import type { Session } from '../../store/session-store'

interface Props {
  session: Session | null
}

export function SessionPanel({ session }: Props) {
  if (!session) {
    return (
      <div className="rp">
        <div className="rp-head"><IconInfoCircle size={14} /> Session</div>
        <div className="rp-body" />
      </div>
    )
  }

  const doneCount = session.steps.filter((s) => s.status === 'done').length
  const errorCount = session.steps.filter((s) => s.status === 'error').length
  const runningCount = session.steps.filter((s) => s.status === 'running').length
  const pendingCount = session.steps.length - doneCount - errorCount - runningCount

  const secondLabel = session.status === 'failed' ? 'failed' :
    session.status === 'done' ? 'errors' : 'pending'
  const secondCount = session.status === 'failed' ? errorCount :
    session.status === 'done' ? errorCount : pendingCount + runningCount

  return (
    <div className="rp">
      <div className="rp-head">
        <IconInfoCircle size={14} />
        {session.type === 'manual' ? 'Request' : 'Session'}
      </div>
      <div className="rp-body">
        {session.type === 'ai' && (
          <div className="stat-grid">
            <div className="stat">
              <div className="sn" style={{ color: '#22c55e' }}>{doneCount}</div>
              <div className="sl">done</div>
            </div>
            <div className="stat">
              <div className="sn" style={{ color: secondCount > 0 && secondLabel === 'failed' ? '#ef4444' : '#bbb' }}>
                {secondCount}
              </div>
              <div className="sl">{secondLabel}</div>
            </div>
          </div>
        )}

        {session.type === 'manual' && (
          <div className="rs">
            <div className="rl">Type</div>
            <div className="rv">Manual</div>
          </div>
        )}

        {session.source && (
          <div className="rs">
            <div className="rl">Source</div>
            <div className="rv">{session.source}</div>
            <div className="rsub">{new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · MCP</div>
          </div>
        )}

        {session.task && (
          <div className="rs">
            <div className="rl">Task</div>
            <div className="task-desc">"{session.task}"</div>
          </div>
        )}

        {session.environment && (
          <div className="rs">
            <div className="rl">Environment</div>
            <div className="env-row">
              <div className="env-dot" />
              {session.environment}
            </div>
          </div>
        )}

        {session.status === 'failed' && (
          <div className="rs">
            <div className="rl">Failed at</div>
            {session.steps.filter(s => s.status === 'error').map(s => (
              <div key={s.id}>
                <div className="rv">{s.method} {s.url}</div>
                <div className="rsub">{s.statusCode} {s.statusCode === 403 ? 'Forbidden' : 'Error'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
