import { IconBolt, IconPlus, IconRobot, IconCursorText, IconPlug, IconSettings } from '@tabler/icons-react'
import { useSessionStore } from '../../store/session-store'
import type { Session } from '../../store/session-store'

function StatusDot({ status }: { status: Session['status'] }) {
  const cls =
    status === 'running' ? 'sdot d-run' :
    status === 'done' ? 'sdot d-done' :
    status === 'failed' ? 'sdot d-err' :
    'sdot d-idle'
  return <div className={cls} />
}

function SessionItem({ session, active, onClick }: { session: Session; active: boolean; onClick: () => void }) {
  const Icon = session.type === 'ai' ? IconRobot : IconCursorText
  return (
    <div className={`si${active ? ' active' : ''}`} onClick={onClick}>
      <Icon size={14} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px' }}>
        {session.name}
      </span>
      <StatusDot status={session.status} />
    </div>
  )
}

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const addSession = useSessionStore((s) => s.addSession)

  const liveSessions = sessions.filter((s) => s.status === 'running')
  const recentSessions = sessions.filter((s) => s.status !== 'running')

  function newManualSession() {
    const id = `manual-${Date.now()}`
    addSession({
      id,
      type: 'manual',
      name: 'New request',
      status: 'idle',
      startedAt: Date.now(),
      steps: [{ id: `${id}-input`, type: 'manual-input', status: 'running' }],
      environment: 'Production',
    })
    setActiveSession(id)
  }

  return (
    <div className="sb">
      <div className="sb-brand">
        <div className="bmark"><IconBolt size={13} color="#fff" /></div>
        <span className="bname">Sentris</span>
        <span className="bver">v1</span>
      </div>

      <div className="sb-new" onClick={newManualSession}>
        <IconPlus size={13} /> New request
      </div>

      {liveSessions.length > 0 && (
        <>
          <div className="sb-sec">Live</div>
          {liveSessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onClick={() => setActiveSession(s.id)}
            />
          ))}
        </>
      )}

      {recentSessions.length > 0 && (
        <>
          <div className="sb-sec">Recent</div>
          {recentSessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onClick={() => setActiveSession(s.id)}
            />
          ))}
        </>
      )}

      <div className="sb-footer">
        <div className="sf"><IconPlug size={14} /> MCP connections</div>
        <div className="sf"><IconSettings size={14} /> Settings</div>
      </div>
    </div>
  )
}
