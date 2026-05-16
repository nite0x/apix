import { useWebSocket } from '../../hooks/use-websocket'
import { useSessionStore } from '../../store/session-store'
import { Sidebar } from '../sidebar/sidebar'
import { Topbar } from '../topbar/topbar'
import { Timeline } from '../timeline/timeline'
import { SessionPanel } from '../right-panel/session-panel'

export function Shell() {
  useWebSocket()

  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Topbar session={activeSession} />
        <div className="content">
          {activeSession ? (
            <Timeline session={activeSession} />
          ) : (
            <div className="tl-empty">Select a session from the sidebar</div>
          )}
          <SessionPanel session={activeSession} />
        </div>
      </div>
    </div>
  )
}
