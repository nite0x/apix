import { IconBolt, IconHistory, IconPlus, IconRobot, IconCursorText, IconPlug, IconSettings, IconShieldCheck, IconVariable } from '@tabler/icons-react'
import { useSessionStore } from '../../store/session-store'
import type { Session } from '../../store/session-store'
import { useRuleStore } from '../../store/rule-store'

function StatusDot({ status }: { status: Session['status'] }) {
  const cls =
    status === 'running' ? 'sdot d-run' :
    status === 'paused' ? 'sdot d-paused' :
    status === 'done' ? 'sdot d-done' :
    status === 'failed' ? 'sdot d-err' :
    status === 'stopped' ? 'sdot d-err' :
    'sdot d-idle'
  return <span className={cls} title={status} aria-label={`${status} status`} />
}

function SessionItem({ session, active, onClick }: { session: Session; active: boolean; onClick: () => void }) {
  const Icon = session.type === 'ai' ? IconRobot : IconCursorText
  return (
    <button type="button" className={`si${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <span className="si-icon"><Icon size={13} /></span>
      <span className="si-label">{session.name}</span>
      <StatusDot status={session.status} />
    </button>
  )
}

interface Props {
  onNewFlow: () => void
  onOpenRules: () => void
  onOpenVariables: () => void
  onOpenRunHistory: () => void
}

export function Sidebar({ onNewFlow, onOpenRules, onOpenVariables, onOpenRunHistory }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const ruleCount = useRuleStore((s) => s.rules.length)
  const liveSessions = sessions.filter((s) => s.status === 'running' || s.status === 'paused' || s.status === 'draft')
  const recentSessions = sessions.filter((s) => s.status !== 'running' && s.status !== 'paused' && s.status !== 'draft')

  return (
    <div className="sb">
      <div className="sb-brand">
        <div className="bmark"><IconBolt size={14} color="#fff" /></div>
        <span className="bname">Apix</span>
        <span className="bver">v4</span>
      </div>

      <div className="sb-scroll">
        <button type="button" className="sb-new" onClick={onNewFlow}>
          <span className="sb-new-icon"><IconPlus size={13} /></span>
          <span>New flow</span>
        </button>

        {liveSessions.length > 0 && (
          <section className="sb-group" aria-labelledby="sidebar-live">
            <div className="sb-sec" id="sidebar-live">Live</div>
            {liveSessions.map((s) => <SessionItem key={s.id} session={s} active={s.id === activeSessionId} onClick={() => setActiveSession(s.id)} />)}
          </section>
        )}

        {recentSessions.length > 0 && (
          <section className="sb-group" aria-labelledby="sidebar-recent">
            <div className="sb-sec" id="sidebar-recent">Recent</div>
            {recentSessions.map((s) => <SessionItem key={s.id} session={s} active={s.id === activeSessionId} onClick={() => setActiveSession(s.id)} />)}
          </section>
        )}

        <section className="sb-group sb-tools" aria-labelledby="sidebar-tools">
          <div className="sb-sec" id="sidebar-tools">Tools</div>
          <button type="button" className="si" onClick={onOpenRunHistory}><span className="si-icon"><IconHistory size={13} /></span><span className="si-label">Run history</span></button>
          <button type="button" className="si" onClick={onOpenRules}><span className="si-icon"><IconShieldCheck size={13} /></span><span className="si-label">Pause rules</span>{ruleCount > 0 && <span className="tool-count">{ruleCount}</span>}</button>
          <button type="button" className="si" onClick={onOpenVariables}><span className="si-icon"><IconVariable size={13} /></span><span className="si-label">Variables</span></button>
        </section>
      </div>

      <div className="sb-footer">
        <div className="sf"><IconPlug size={14} /> MCP connections</div>
        <div className="sf"><IconSettings size={14} /> Settings</div>
      </div>
    </div>
  )
}
