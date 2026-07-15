import { useEffect, useState } from 'react'
import {
  IconArchive,
  IconArrowDownLeft,
  IconArrowUpRight,
  IconFileCode,
  IconFileDescription,
  IconLoader,
  IconPencil,
  IconPlayerPlay,
  IconRobot,
  IconSend,
  IconShieldCheck,
  IconTimeline,
  IconVariable,
} from '@tabler/icons-react'
import type { ApiDefinition, ApiRule } from '../../data/api-catalog'
import { tryApi, type TryResult } from '../../services/api-client'

type DetailTab = 'overview' | 'parameters' | 'rules' | 'history'

interface RunContext {
  request: string
  authorization?: string
  rule?: string
}
interface Props {
  api: ApiDefinition
  context: 'run' | 'library'
  runContext?: RunContext
  onJumpToSession?: () => void
  onEdit?: () => void
  onArchive?: () => void
}

function methodClass(method: string) {
  return `det-method am-${method.toLowerCase()}`
}

export function ApiDetail({ api, context, runContext, onJumpToSession, onEdit, onArchive }: Props) {
  const [tab, setTab] = useState<DetailTab>('overview')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiNote, setAiNote] = useState('')
  const [rules, setRules] = useState<ApiRule[]>(api.rules)
  const [trying, setTrying] = useState(false)
  const [tryResult, setTryResult] = useState<TryResult | null>(null)
  const [tryError, setTryError] = useState<string | null>(null)

  useEffect(() => {
    setTab('overview')
    setAiOpen(false)
    setAiNote('')
    setRules(api.rules)
    setTryResult(null)
    setTryError(null)
  }, [api])

  async function sendTry() {
    setTrying(true)
    setTryError(null)
    try {
      setTryResult(await tryApi(api))
    } catch (error) {
      setTryError(error instanceof Error ? error.message : 'Request failed')
    } finally {
      setTrying(false)
    }
  }

  function toggleRule(id: string) {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, enabled: !rule.enabled, triggered: false } : rule))
  }

  return (
    <div className="api-detail">
      {context === 'run' && runContext && (
        <div className="exec-ctx">
          <div className="ec-lbl"><IconTimeline size={11} /> Current run values</div>
          <div className="ec-row"><span className="ec-k">Request</span><span className="ec-v">{runContext.request}</span></div>
          {runContext.authorization && (
            <div className="ec-row">
              <span className="ec-k">Authorization</span>
              <span className="ec-v">{runContext.authorization}</span>
              <span className="ec-badge">{'{{token}}'}</span>
            </div>
          )}
          {runContext.rule && (
            <div className="ec-row ec-rule-row"><span className="ec-k">Rule</span><span className="ec-v ec-rule-value">{runContext.rule}</span></div>
          )}
        </div>
      )}

      <div className="det-head">
        <div className="det-mrow">
          <span className={methodClass(api.method)}>{api.method}</span>
          <span className="det-url">{api.url}</span>
        </div>
        <span className="det-name">
          {api.name} · {api.collectionName}
          {api.source === 'fixture' && <span className="demo-label">preview</span>}
        </span>
        <div className="det-acts">
          {onEdit && api.source === 'backend' && (
            <button type="button" className="det-btn" onClick={onEdit}>
              <IconPencil size={12} /> 编辑
            </button>
          )}
          {onArchive && api.source === 'backend' && (
            <button type="button" className="det-btn det-btn-danger" onClick={onArchive}>
              <IconArchive size={12} /> 归档
            </button>
          )}
          <button type="button" className={`det-btn ai-btn${aiOpen ? ' active' : ''}`} onClick={() => setAiOpen((open) => !open)}>
            <IconRobot size={12} /> 用 AI 编辑
          </button>
          <button type="button" className="det-btn" onClick={() => document.getElementById(`try-${context}-${api.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>
            <IconPlayerPlay size={12} /> Try it
          </button>
        </div>
        {aiOpen && (
          <div className="ai-bar">
            <IconRobot size={13} />
            <input value={aiNote} onChange={(event) => setAiNote(event.target.value)} placeholder='例如：“加一条 Rule，暂停 DELETE”' />
            <button type="button" disabled={!aiNote.trim()} onClick={() => setAiNote('AI editing requires runtime support')}>发送</button>
          </div>
        )}
      </div>

      <div className="det-tabs" role="tablist" aria-label="API detail">
        {(['overview', 'parameters', 'rules', 'history'] as DetailTab[]).map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={`det-tab${tab === item ? ' active' : ''}`}
            key={item}
            onClick={() => setTab(item)}
          >
            {item === 'parameters' ? 'Parameters' : item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>

      <div className="det-body">
        {tab === 'overview' && (
          <div className="det-pane active">
            <div className="dp-sec">
              <div className="dp-lbl"><IconFileDescription size={12} /> Description</div>
              {onEdit && api.source === 'backend' ? (
                <button type="button" className="dp-desc" onClick={onEdit}>{api.description || 'Saved API request.'}<span className="ehint">编辑</span></button>
              ) : (
                <div className="dp-desc dp-desc-static">{api.description || 'Saved API request.'}</div>
              )}
            </div>

            <div className="dp-sec">
              <div className="dp-lbl"><IconVariable size={12} /> Variable bindings</div>
              {api.bindings.length === 0 && <div className="det-empty-copy">No variable bindings</div>}
              {api.bindings.map((binding) => (
                <div className={`vb vb-${binding.direction}`} key={`${binding.direction}-${binding.name}`}>
                  {binding.direction === 'in' ? <IconArrowDownLeft size={11} /> : <IconArrowUpRight size={11} />}
                  <span>{`{{${binding.name}}}`}</span>
                  <span className={binding.direction === 'in' ? 'vb-src' : 'vb-src-g'}>{binding.direction === 'in' ? '←' : '→'} {binding.source}</span>
                </div>
              ))}
            </div>

            {api.aiUsage && (
              <div className="dp-sec">
                <div className="dp-lbl"><IconRobot size={12} /> AI usage</div>
                <div className="ai-strip">
                  <IconRobot size={13} /> Used <strong>{api.aiUsage.count}×</strong>
                  <span className="ai-div" /> {api.aiUsage.succeeded} ok · <span className="ai-failed">{api.aiUsage.failed} err</span>
                  <span className="ai-div" /> avg <strong>{api.aiUsage.averageMs}ms</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'parameters' && (
          <div className="det-pane active">
            {api.parameters.length === 0 ? <div className="det-empty-copy">No parameters defined</div> : (
              <table className="ptbl">
                <thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead>
                <tbody>
                  {api.parameters.map((parameter) => (
                    <tr key={`${parameter.location}-${parameter.name}`}>
                      <td><span className="p-nm">{parameter.name}</span></td>
                      <td><span className={`p-in pin-${parameter.location}`}>{parameter.location}</span></td>
                      <td><span className="p-type">{parameter.type}</span>{parameter.required && <span className="p-req"> required</span>}</td>
                      <td className="p-desc">{parameter.description ?? parameter.defaultValue ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {api.responseSchema && (
              <div className="response-schema">
                <div className="dp-lbl"><IconFileCode size={12} /> Response 200</div>
                <div className="schema-code">
                  {Object.entries(api.responseSchema).map(([name, type]) => <div key={name}>{name}: <span>{type}</span></div>)}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'rules' && (
          <div className="det-pane active">
            {rules.length === 0 && <div className="det-empty-copy">No rules match this API</div>}
            {rules.map((rule) => (
              <div className={`rule-row${rule.triggered ? ' triggered' : ''}`} key={rule.id}>
                <button type="button" role="switch" aria-checked={rule.enabled} aria-label={rule.label} className={`rrtog ${rule.enabled ? 'on' : 'off'}`} onClick={() => toggleRule(rule.id)}>
                  <span className="rrtog-k" />
                </button>
                <IconShieldCheck size={13} />
                <span className="rr-lbl">{rule.label}</span>
                {rule.triggered ? <span className="rr-b rrb-tri">triggered now</span> : <span className="rule-state">{rule.enabled ? 'on' : 'off'}</span>}
              </div>
            ))}
            <button type="button" className="add-il">+ Add rule</button>
          </div>
        )}

        {tab === 'history' && (
          <div className="det-pane active">
            {api.history.length === 0 && <div className="det-empty-copy">No runs recorded yet</div>}
            {api.history.map((item) => (
              <div className="hist" key={item.id}>
                <span className={`h-sc ${item.status < 400 ? 'hsc-ok' : 'hsc-err'}`}>{item.status}</span>
                <span>{item.label}</span>
                <span className="h-t">{item.time}{item.durationMs ? ` · ${item.durationMs}ms` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="try-wrap" id={`try-${context}-${api.id}`}>
        <div className="try-head"><IconPlayerPlay size={12} /><span className="try-ttl">Try it</span><span className="try-env">Production</span></div>
        {api.parameters.length > 0 && (
          <div className="try-row">
            {api.parameters.slice(0, 2).map((parameter) => (
              <label className="try-f" key={`${parameter.location}-${parameter.name}`}>
                <span className="try-lbl">{parameter.name} <span className={`p-in pin-${parameter.location}`}>{parameter.location}</span>{parameter.required && <span className="p-req">required</span>}</span>
                <input className={`try-inp${parameter.name === 'id' ? ' res' : ''}`} defaultValue={parameter.defaultValue ?? ''} />
                {parameter.name === 'id' && <span className="try-hint"><IconVariable size={10} /> can resolve from variable</span>}
              </label>
            ))}
          </div>
        )}
        <div className="try-actions">
          <button type="button" className="try-send" disabled={trying} onClick={() => void sendTry()}>
            {trying ? <><IconLoader size={12} /> Sending…</> : <><IconSend size={12} /> Send</>}
          </button>
          <span className="try-note"><IconTimeline size={11} /> result is recorded in session history</span>
        </div>
        {tryError && <div className="try-error">{tryError}</div>}
        {tryResult && (
          <div className="try-res show">
            <div className="trh">
              <span className="trh-sc">{tryResult.status}</span>
              <span className="trh-ms">{tryResult.durationMs}ms · {tryResult.size}</span>
              {tryResult.demo && <span className="demo-label">preview</span>}
              {onJumpToSession && <button type="button" className="trh-jump" onClick={onJumpToSession}>→ 会话视图</button>}
            </div>
            <pre className="trb">{JSON.stringify(tryResult.body, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
