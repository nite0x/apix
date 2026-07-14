import { IconBolt, IconPlus, IconRobot, IconCursorText, IconPlug, IconSettings, IconShieldCheck, IconVariable } from '@tabler/icons-react'
import { useSessionStore } from '../../store/session-store'
import type { Session } from '../../store/session-store'

function StatusDot({ status }: { status: Session['status'] }) {
  const cls =
    status === 'running' ? 'sdot d-run' :
    status === 'paused' ? 'sdot d-paused' :
    status === 'done' ? 'sdot d-done' :
    status === 'failed' ? 'sdot d-err' :
    status === 'stopped' ? 'sdot d-err' :
    'sdot d-idle'
  return <div className={cls} />
}

function SessionItem({ session, active, onClick }: { session: Session; active: boolean; onClick: () => void }) {
  const Icon = session.type === 'ai' ? IconRobot : IconCursorText
  return (
    <button type="button" className={`si${active ? ' active' : ''}`} onClick={onClick}>
      <Icon size={14} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px' }}>
        {session.name}
      </span>
      <StatusDot status={session.status} />
    </button>
  )
}

interface Props {
  onNewFlow: () => void
  onOpenRules: () => void
  onOpenVariables: () => void
}

export function Sidebar({ onNewFlow, onOpenRules, onOpenVariables }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const liveSessions = sessions.filter((s) => s.status === 'running' || s.status === 'paused' || s.status === 'draft')
  const recentSessions = sessions.filter((s) => s.status !== 'running' && s.status !== 'paused' && s.status !== 'draft')

  return (
    <div className="sb">
      <div className="sb-brand">
        <div className="bmark"><IconBolt size={13} color="#fff" /></div>
        <span className="bname">APIX</span>
        <span className="bver">v4</span>
      </div>

      <div className="sb-scroll">
        <button type="button" className="sb-new" onClick={onNewFlow}><IconPlus size={13} /> New flow</button>

        {liveSessions.length > 0 && (
          <>
            <div className="sb-sec">Live</div>
            {liveSessions.map((s) => <SessionItem key={s.id} session={s} active={s.id === activeSessionId} onClick={() => setActiveSession(s.id)} />)}
          </>
        )}

        {recentSessions.length > 0 && (
          <>
            <div className="sb-sec">Recent</div>
            {recentSessions.map((s) => <SessionItem key={s.id} session={s} active={s.id === activeSessionId} onClick={() => setActiveSession(s.id)} />)}
          </>
        )}

        <div className="sb-divider" />
        <div className="sb-sec">Tools</div>
        <button type="button" className="si" onClick={onOpenRules}><IconShieldCheck size={14} /><span className="si-label">Pause rules</span><span className="tool-count">2</span></button>
        <button type="button" className="si" onClick={onOpenVariables}><IconVariable size={14} /><span className="si-label">Variables</span></button>
      </div>

      <div className="sb-footer">
        <div className="sf"><IconPlug size={14} /> MCP connections</div>
        <div className="sf"><IconSettings size={14} /> Settings</div>
      </div>
    </div>
  )
}
