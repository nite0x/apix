import type { Session } from '../../store/session-store'

interface Props {
  session: Session | null
}

export function Topbar({ session }: Props) {
  if (!session) {
    return (
      <div className="topbar">
        <div className="tb-title" style={{ color: '#bbb' }}>Select a session</div>
      </div>
    )
  }

  const pill =
    session.status === 'running' ? 'pill pl-run' :
    session.status === 'done' ? 'pill pl-done' :
    session.status === 'failed' ? 'pill pl-err' :
    'pill pl-manual'

  const pillText =
    session.status === 'running'
      ? `Running · step ${session.steps.filter(s => s.status === 'done').length + 1}`
      : session.status === 'done'
        ? `Done · ${session.steps.filter(s => s.type !== 'think').length} steps`
        : session.status === 'failed'
          ? `Failed · step ${session.steps.findIndex(s => s.status === 'error') + 1}`
          : 'Manual'

  const titleStyle =
    session.type === 'manual' ? { fontFamily: 'monospace', fontSize: '12px' } : {}

  return (
    <div className="topbar">
      <div className="tb-title" style={titleStyle}>
        {session.type === 'manual' ? 'Manual request' : session.name}
      </div>
      <div className={pill}>
        <div className="porb" />
        <span>{pillText}</span>
      </div>
    </div>
  )
}
