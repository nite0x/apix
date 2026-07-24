import { useEffect, useState } from 'react'
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import type { RuleTrigger } from '../../services/api-client'
import {
  HTTP_METHODS,
  rulesAreDirty,
  useRuleStore,
  validateRule,
} from '../../store/rule-store'

interface Props {
  onClose: () => void
}

export function RulesManager({ onClose }: Props) {
  const rules = useRuleStore((s) => s.rules)
  const savedRules = useRuleStore((s) => s.savedRules)
  const loadState = useRuleStore((s) => s.loadState)
  const saveState = useRuleStore((s) => s.saveState)
  const error = useRuleStore((s) => s.error)
  const loadRules = useRuleStore((s) => s.loadRules)
  const reload = useRuleStore((s) => s.reload)
  const reset = useRuleStore((s) => s.reset)
  const saveRules = useRuleStore((s) => s.saveRules)
  const createRule = useRuleStore((s) => s.createRule)
  const updateRule = useRuleStore((s) => s.updateRule)
  const updateRuleMatch = useRuleStore((s) => s.updateRuleMatch)
  const deleteRule = useRuleStore((s) => s.deleteRule)
  const toggleRule = useRuleStore((s) => s.toggleRule)

  const [selectedId, setSelectedId] = useState<string | null>(rules[0]?.id ?? null)
  const [confirmClose, setConfirmClose] = useState(false)

  const dirty = rulesAreDirty(rules, savedRules)
  const selected = rules.find((rule) => rule.id === selectedId) ?? null
  const selectedError = selected ? validateRule(selected) : null

  useEffect(() => {
    // Opening the manager always reloads from the runtime.
    void loadRules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedId && rules.length > 0) setSelectedId(rules[0].id)
    if (selectedId && !rules.some((rule) => rule.id === selectedId)) setSelectedId(rules[0]?.id ?? null)
  }, [rules, selectedId])

  function requestClose() {
    if (dirty) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      // Intercept before the Shell's global Escape so unsaved changes confirm first.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (confirmClose) {
        setConfirmClose(false)
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmClose, dirty])

  function handleCreate() {
    const id = createRule('before')
    setSelectedId(id)
  }

  function handleTriggerChange(id: string, trigger: RuleTrigger) {
    updateRule(id, { trigger })
    // Clear fields that do not belong to the new trigger so we never save stale matches.
    if (trigger === 'before') updateRuleMatch(id, { status_range: undefined })
    else updateRuleMatch(id, { method: undefined, url_pattern: undefined, env: undefined })
  }

  const blocking = rules.length === 0
  const showLoading = loadState === 'loading' && blocking
  const showError = loadState === 'error' && blocking
  const showEmpty = loadState === 'empty' && rules.length === 0 && !dirty

  return (
    <div className="lib-overlay open" role="presentation">
      <section className="lib-modal" role="dialog" aria-modal="true" aria-label="Pause Rules">
        <div className="lib-header">
          <div className="lib-title"><IconShieldCheck size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Pause Rules</div>
          {dirty && <span className="ed-dirty">未保存修改</span>}
          <button type="button" className="lib-hbtn" aria-label="重新加载规则" onClick={() => void reload()} disabled={loadState === 'loading' || saveState === 'saving'}>
            <IconRefresh size={12} /> 重新加载
          </button>
          <button type="button" className="lib-close" aria-label="关闭规则管理" onClick={requestClose}><IconX size={15} /></button>
        </div>

        {showLoading && (
          <div className="catalog-status" role="status"><IconLoader2 className="catalog-spinner" size={14} /><span>加载规则中…</span></div>
        )}
        {showError && (
          <div className="catalog-status" role="alert">
            <span>{error ?? '加载规则失败'}</span>
            <button type="button" className="catalog-retry" onClick={() => void reload()}><IconRefresh size={12} /> Retry</button>
          </div>
        )}

        {!showLoading && !showError && (
          <div className="lib-body">
            <div className="col-apis rules-list-col">
              <div className="col-apis-head">
                <span className="col-apis-title">规则（{rules.length}）</span>
                <button type="button" aria-label="新建规则" onClick={handleCreate}><IconPlus size={12} /></button>
              </div>
              <div className="api-list">
                {rules.length === 0 && <div className="api-list-empty">还没有任何规则</div>}
                {rules.map((rule) => {
                  const invalid = validateRule(rule)
                  return (
                    <button
                      type="button"
                      key={rule.id}
                      className={`rule-list-it${rule.id === selectedId ? ' active' : ''}`}
                      onClick={() => setSelectedId(rule.id)}
                    >
                      <span
                        role="switch"
                        aria-checked={rule.enabled}
                        aria-label={`启用规则 ${rule.name || '未命名'}`}
                        className={`rrtog ${rule.enabled ? 'on' : 'off'}`}
                        onClick={(event) => { event.stopPropagation(); toggleRule(rule.id) }}
                      >
                        <span className="rrtog-k" />
                      </span>
                      <span className="rule-list-nm">{rule.name || '未命名规则'}</span>
                      <span className={`rule-trig rt-${rule.trigger}`}>{rule.trigger}</span>
                      {invalid && <IconAlertTriangle size={12} color="#b45309" aria-label="规则不完整" />}
                    </button>
                  )
                })}
              </div>
              <div className="col-apis-footer">
                <button type="button" className="api-add-btn" onClick={handleCreate}><IconPlus size={12} /> 新建规则</button>
              </div>
            </div>

            <div className="col-det rules-detail-col">
              {selected ? (
                <div className="rule-form" aria-label="规则编辑">
                  <div className="rule-form-body">
                    <label className="ed-field">
                      <span className="ed-lbl">名称</span>
                      <input
                        className="ed-inp"
                        value={selected.name}
                        placeholder="规则名称"
                        aria-label="规则名称"
                        onChange={(event) => updateRule(selected.id, { name: event.target.value })}
                      />
                    </label>

                    <div className="ed-field">
                      <span className="ed-lbl">状态</span>
                      <div className="rule-inline">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={selected.enabled}
                          aria-label="启用规则"
                          className={`rrtog ${selected.enabled ? 'on' : 'off'}`}
                          onClick={() => toggleRule(selected.id)}
                        >
                          <span className="rrtog-k" />
                        </button>
                        <span className="rule-inline-lbl">{selected.enabled ? '已启用' : '已停用'}</span>
                      </div>
                    </div>

                    <label className="ed-field">
                      <span className="ed-lbl">触发时机</span>
                      <select
                        className="ed-inp"
                        aria-label="触发时机"
                        value={selected.trigger}
                        onChange={(event) => handleTriggerChange(selected.id, event.target.value as RuleTrigger)}
                      >
                        <option value="before">before（请求前）</option>
                        <option value="after">after（响应后）</option>
                      </select>
                    </label>

                    <div className="ed-field">
                      <span className="ed-lbl">动作</span>
                      <div className="rule-action-fixed">pause（暂停等待人工确认）</div>
                    </div>

                    {selected.trigger === 'before' ? (
                      <>
                        <label className="ed-field">
                          <span className="ed-lbl">Method（可选）</span>
                          <select
                            className="ed-inp"
                            aria-label="Method"
                            value={selected.match.method ?? ''}
                            onChange={(event) => updateRuleMatch(selected.id, { method: event.target.value || undefined })}
                          >
                            <option value="">不限</option>
                            {HTTP_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                          </select>
                        </label>
                        <label className="ed-field">
                          <span className="ed-lbl">URL Pattern（可选）</span>
                          <input
                            className="ed-inp ed-url"
                            value={selected.match.url_pattern ?? ''}
                            placeholder="例如 */users*"
                            aria-label="URL Pattern"
                            onChange={(event) => updateRuleMatch(selected.id, { url_pattern: event.target.value || undefined })}
                          />
                        </label>
                        <label className="ed-field">
                          <span className="ed-lbl">环境（可选）</span>
                          <input
                            className="ed-inp"
                            value={selected.match.env ?? ''}
                            placeholder="例如 production"
                            aria-label="环境"
                            onChange={(event) => updateRuleMatch(selected.id, { env: event.target.value || undefined })}
                          />
                        </label>
                      </>
                    ) : (
                      <label className="ed-field">
                        <span className="ed-lbl">状态码范围</span>
                        <input
                          className="ed-inp"
                          value={selected.match.status_range ?? ''}
                          placeholder="例如 400-499 或 404"
                          aria-label="状态码范围"
                          onChange={(event) => updateRuleMatch(selected.id, { status_range: event.target.value || undefined })}
                        />
                      </label>
                    )}

                    {selectedError && <div className="rule-form-error" role="alert"><IconAlertTriangle size={12} /> {selectedError}</div>}
                  </div>

                  <div className="rule-form-foot">
                    <button type="button" className="ed-btn danger" onClick={() => deleteRule(selected.id)}>
                      <IconTrash size={13} /> 删除规则
                    </button>
                  </div>
                </div>
              ) : showEmpty ? (
                <div className="det-empty">
                  <IconShieldCheck size={28} />
                  <p>还没有任何 Pause Rule</p>
                  <button type="button" className="ed-btn primary" onClick={handleCreate}><IconPlus size={13} /> 新建规则</button>
                </div>
              ) : (
                <div className="det-empty"><IconShieldCheck size={28} /><p>选择或新建一条规则</p></div>
              )}
            </div>
          </div>
        )}

        <div className="rules-foot">
          <div className="rules-foot-status" role="status" aria-live="polite">
            {saveState === 'saving' && <><IconLoader2 className="catalog-spinner" size={13} /> 保存中…</>}
            {saveState === 'saved' && !dirty && <span className="rules-saved"><IconCheck size={13} /> 已保存</span>}
            {saveState === 'error' && <span className="rules-save-error"><IconAlertTriangle size={13} /> {error ?? '保存失败'}</span>}
          </div>
          <div className="ed-foot-right">
            <button type="button" className="ed-btn" onClick={reset} disabled={!dirty || saveState === 'saving'}>放弃修改</button>
            <button type="button" className="ed-btn primary" onClick={() => void saveRules()} disabled={!dirty || saveState === 'saving'}>
              保存全部更改
            </button>
          </div>
        </div>

        {confirmClose && (
          <div className="lib-confirm-overlay" role="presentation">
            <div className="lib-confirm" role="alertdialog" aria-modal="true" aria-label="放弃未保存修改">
              <div className="lib-confirm-icon"><IconAlertTriangle size={18} /></div>
              <div className="lib-confirm-title">放弃未保存修改</div>
              <p className="lib-confirm-body">规则改动尚未保存，关闭后将丢弃这些修改。确认放弃？</p>
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => setConfirmClose(false)}>继续编辑</button>
                <button type="button" className="ed-btn primary danger" onClick={() => { setConfirmClose(false); reset(); onClose() }}>放弃并关闭</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
