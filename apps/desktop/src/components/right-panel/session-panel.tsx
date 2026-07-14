import { useEffect, useState } from 'react'
import { IconShieldCheck } from '@tabler/icons-react'
import type { Session } from '../../store/session-store'

interface Props {
  session: Session | null
  activeTab: 'session' | 'rules'
  onTabChange: (tab: 'session' | 'rules') => void
}
const baseRules = [
  { id: 'r-delete', label: 'Pause before DELETE', enabled: true },
  { id: 'r-4xx', label: 'Pause if response is 4xx', enabled: false },
]

export function SessionPanel({ session, activeTab, onTabChange }: Props) {
  const [rules, setRules] = useState(baseRules)
  useEffect(() => {
    if (session?.matchedRule && !rules.some((rule) => rule.id === session.matchedRule?.id)) {
      setRules((current) => [{ id: session.matchedRule!.id, label: session.matchedRule!.name, enabled: true }, ...current])
    }
    // Rules are kept as local UI state until the editing API is expanded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.matchedRule?.id])

  if (!session) return <aside className="rp"><div className="rp-body" /></aside>

  const doneCount = session.steps.filter((step) => step.status === 'done').length
  const pendingCount = session.steps.filter((step) => step.status === 'pending' || step.status === 'running' || step.status === 'paused').length

  return (
    <aside className="rp" aria-label="Session details">
      <div className="rp-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'session'} className={`rp-tab${activeTab === 'session' ? ' active' : ''}`} onClick={() => onTabChange('session')}>Session</button>
        <button type="button" role="tab" aria-selected={activeTab === 'rules'} className={`rp-tab${activeTab === 'rules' ? ' active' : ''}`} onClick={() => onTabChange('rules')}>Rules{session.matchedRule && <span className="rp-alert">!</span>}</button>
      </div>

      <div className="rp-body">
        {activeTab === 'session' ? (
          session.status === 'draft' ? (
            <>
              <div className="rs"><div className="rl">Flow status</div><div className="run-card"><div className="run-line"><span className="context-chip ctx-paused">Draft</span><strong>New flow</strong></div><div className="run-line muted-copy">No requests sent yet</div></div></div>
              <div className="rs"><div className="rl">Start with</div><div className="info-card"><strong>Blank request or API Library</strong>Add the first request, then APIX will show the run timeline here.</div></div>
              <div className="rs"><div className="rl">Environment</div><div className="env-row"><span className="env-dot" />{session.environment ?? 'Production'}</div></div>
            </>
          ) : (
            <>
              <div className="rs">
                <div className="rl">Run status</div>
                <div className="run-card">
                  <div className="run-line"><span className={`context-chip ctx-${session.status}`}>{session.status[0].toUpperCase() + session.status.slice(1)}</span><strong>Step {session.currentStep ?? Math.max(doneCount + 1, 1)}</strong></div>
                  <div className="run-line"><span className="done-copy">{doneCount} done</span><span className="pending-copy">/ {pendingCount} pending</span></div>
                  <div className="run-line"><span className="context-chip ctx-prod">{session.environment ?? 'Production'}</span><span className="elapsed-copy">{session.elapsedMs ?? 0}ms elapsed</span></div>
                </div>
              </div>

              {session.matchedRule && (
                <div className="rs"><div className="rl">Matched rule</div><div className="warn-card"><strong>{session.matchedRule.name}</strong>{session.matchedRule.description}</div></div>
              )}

              <div className="rs">
                <div className="rl">Resolved variables</div>
                {(session.variables?.length ?? 0) === 0 && <div className="rsub">No variables resolved</div>}
                {session.variables?.map((variable) => (
                  <div className="rv-item" key={variable.name}>
                    <div className="rv-head"><span className="rv-scope">{variable.scope.toUpperCase()}</span><span className="rv-name">{variable.name}</span><span className="rv-st">active</span></div>
                    <div className="rv-body"><div className="rv-val" title="Sensitive values are masked">{variable.valuePreview ?? '••••••••••••'}</div></div>
                  </div>
                ))}
              </div>

              {session.source && <div className="rs"><div className="rl">Source</div><div className="rv">{session.source}</div><div className="rsub">{new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · MCP</div></div>}
            </>
          )
        ) : (
          <>
            <div className="rs"><div className="rl">Pause rules</div></div>
            {rules.map((rule) => {
              const triggered = session.matchedRule?.id === rule.id
              return (
                <div className={`panel-rule${triggered ? ' triggered' : ''}`} key={rule.id}>
                  <button type="button" role="switch" aria-checked={rule.enabled} aria-label={rule.label} className={`rrtog ${rule.enabled ? 'on' : 'off'}`} onClick={() => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item))}><span className="rrtog-k" /></button>
                  <IconShieldCheck size={13} />
                  <span>{rule.label}</span>
                  {triggered && <span className="rr-b rrb-tri">now</span>}
                </div>
              )
            })}
            <button type="button" className="add-il">+ Add rule</button>
          </>
        )}
      </div>
    </aside>
  )
}
