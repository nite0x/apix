import { useEffect, useState } from 'react'
import { IconExternalLink, IconShieldCheck } from '@tabler/icons-react'
import type { Flow } from '../../services/flow-client'
import { rulesAreDirty, useRuleStore } from '../../store/rule-store'

interface Props {
  flow: Flow
  onManageRules: () => void
}

export function FlowPanel({ flow, onManageRules }: Props) {
  const [tab, setTab] = useState<'flow' | 'rules'>('flow')
  const rules = useRuleStore((state) => state.rules)
  const savedRules = useRuleStore((state) => state.savedRules)
  const loadState = useRuleStore((state) => state.loadState)
  const saveState = useRuleStore((state) => state.saveState)
  const loadRules = useRuleStore((state) => state.loadRules)
  const toggleRule = useRuleStore((state) => state.toggleRule)
  const saveRules = useRuleStore((state) => state.saveRules)
  const dirty = rulesAreDirty(rules, savedRules)

  useEffect(() => {
    if (loadState === 'idle') void loadRules()
  }, [loadRules, loadState])

  return (
    <aside className="rp flow-panel" aria-label="Flow details">
      <div className="rp-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'flow'} className={`rp-tab${tab === 'flow' ? ' active' : ''}`} onClick={() => setTab('flow')}>Flow</button>
        <button type="button" role="tab" aria-selected={tab === 'rules'} className={`rp-tab${tab === 'rules' ? ' active' : ''}`} onClick={() => setTab('rules')}>Rules</button>
      </div>
      <div className="rp-body">
        {tab === 'flow' ? (
          <>
            <div className="rs">
              <div className="rl">Definition</div>
              <div className="run-card">
                <div className="run-line"><strong>{flow.steps.length} steps</strong></div>
                <div className="run-line muted-copy">Flow changes save automatically</div>
              </div>
            </div>
            <div className="rs">
              <div className="rl">Environment</div>
              <div className="env-row"><span className="env-dot" />{flow.environment_id ?? 'Default'}</div>
            </div>
            <div className="rs">
              <div className="rl">Variables</div>
              {flow.variables.length === 0 && <div className="rsub">No Flow variables defined</div>}
              {flow.variables.map((variable) => (
                <div className="rv-item" key={variable.name}>
                  <div className="rv-head">
                    <span className="rv-scope">FLOW</span>
                    <span className="rv-name">{variable.name}</span>
                    {variable.required && <span className="rv-st">required</span>}
                  </div>
                  <div className="rv-body">
                    <div className="rv-val">{variable.secret ? '••••••••' : variable.default_value || '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="rs"><div className="rl">Pause rules</div></div>
            {loadState === 'loading' && rules.length === 0 && <div className="rsub">Loading rules…</div>}
            {loadState !== 'loading' && rules.length === 0 && <div className="rsub">No Pause Rules yet</div>}
            {rules.map((rule) => (
              <div className="panel-rule" key={rule.id}>
                <button type="button" role="switch" aria-checked={rule.enabled} aria-label={rule.name || 'Unnamed rule'} className={`rrtog ${rule.enabled ? 'on' : 'off'}`} onClick={() => toggleRule(rule.id)}><span className="rrtog-k" /></button>
                <IconShieldCheck size={13} />
                <span>{rule.name || 'Unnamed rule'}</span>
              </div>
            ))}
            {dirty && (
              <div className="panel-rule-save">
                <span className="rsub">Rule changes are not saved</span>
                <button type="button" className="ed-btn primary" onClick={() => void saveRules()} disabled={saveState === 'saving'}>
                  {saveState === 'saving' ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            )}
            <button type="button" className="add-il" onClick={onManageRules}><IconExternalLink size={12} /> Manage rules</button>
          </>
        )}
      </div>
    </aside>
  )
}
