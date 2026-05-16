import { useEffect } from 'react'
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
  const loadState = useSessionStore((s) => s.loadState)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Topbar session={activeSession} />
        <div className="content">
          {loadState === 'loading' ? (
            <div className="tl-empty">Loading sessions...</div>
          ) : loadState === 'error' ? (
            <div className="tl-empty">Runtime unavailable</div>
          ) : activeSession ? (
            <Timeline session={activeSession} />
          ) : (
            <div className="tl-empty">No sessions yet</div>
          )}
          <SessionPanel session={activeSession} />
        </div>
      </div>
    </div>
  )
}
