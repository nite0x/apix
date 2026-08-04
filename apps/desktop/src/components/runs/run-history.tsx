import { useEffect, useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconLoader2,
  IconPin,
  IconPinnedFilled,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { useRunHistoryStore } from '../../store/run-history-store'
import type { BackendRun } from '../../services/api-client'
import type { RequestKeyValue } from '../../data/api-catalog'
import { formatClock, formatDuration, formatJson, formatSize, formatTimestamp } from '../../utils/format'

interface Props {
  onClose: () => void
  currentFlowName?: string | null
  onRerun?: (run: BackendRun, destination: 'scratch' | 'flow') => void | Promise<void>
}

function statusClass(run: BackendRun): string {
  if (run.error_code || run.status === 'failed' || run.status === 'error') return 'run-st-err'
  const code = run.response_status ?? 0
  if (code >= 400) return 'run-st-warn'
  if (code >= 200 && code < 400) return 'run-st-ok'
  return 'run-st-idle'
}

function KeyValueList({ label, rows }: { label: string; rows?: RequestKeyValue[] }) {
  const active = (rows ?? []).filter((row) => row.name)
  if (active.length === 0) return null
  return (
    <div className="run-kv-block">
      <div className="dp-lbl">{label}</div>
      {active.map((row, index) => (
        <div className={`run-kv${row.enabled === false ? ' disabled' : ''}`} key={`${row.name}-${index}`}>
          <span className="run-kv-k">{row.name}</span>
          <span className="run-kv-v">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

export function RunHistory({ onClose, currentFlowName = null, onRerun }: Props) {
  const runs = useRunHistoryStore((s) => s.runs)
  const listState = useRunHistoryStore((s) => s.listState)
  const detailState = useRunHistoryStore((s) => s.detailState)
  const detail = useRunHistoryStore((s) => s.detail)
  const detailError = useRunHistoryStore((s) => s.detailError)
  const selectedRunId = useRunHistoryStore((s) => s.selectedRunId)
  const error = useRunHistoryStore((s) => s.error)
  const loadRuns = useRunHistoryStore((s) => s.loadRuns)
  const selectRun = useRunHistoryStore((s) => s.selectRun)
  const togglePinned = useRunHistoryStore((s) => s.togglePinned)
  const deleteRun = useRunHistoryStore((s) => s.deleteRun)

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<BackendRun | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [rerunTarget, setRerunTarget] = useState<BackendRun | null>(null)

  useEffect(() => {
    // Opening Run History always refreshes the list.
    void loadRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statuses = useMemo(() => Array.from(new Set(runs.map((run) => run.status))).sort(), [runs])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return runs.filter((run) => {
      if (pinnedOnly && !run.is_pinned) return false
      if (statusFilter !== 'all' && run.status !== statusFilter) return false
      if (!normalized) return true
      const haystack = `${run.request_snapshot.method} ${run.request_snapshot.url} ${run.api_request_id ?? ''}`.toLowerCase()
      return haystack.includes(normalized)
    })
  }, [runs, query, statusFilter, pinnedOnly])

  async function handleTogglePin(id: string) {
    setPinError(null)
    try {
      await togglePinned(id)
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Pin failed')
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteRun(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  function requestRerun(run: BackendRun) {
    if (!onRerun) return
    if (currentFlowName != null) {
      setRerunTarget(run)
      return
    }
    void onRerun(run, 'scratch')
  }

  function confirmRerun(destination: 'scratch' | 'flow') {
    if (!rerunTarget || !onRerun) return
    const target = rerunTarget
    setRerunTarget(null)
    void onRerun(target, destination)
  }

  const blocking = runs.length === 0
  const showLoading = (listState === 'loading') && blocking
  const showOffline = listState === 'offline' && blocking
  const showError = listState === 'error' && blocking
  const showEmpty = listState === 'empty' && runs.length === 0

  return (
    <div className="lib-overlay open" role="presentation">
      <section className="lib-modal" role="dialog" aria-modal="true" aria-label="请求历史">
        <div className="lib-header">
          <div className="lib-title">请求历史</div>
          <label className="lib-search">
            <IconSearch size={12} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Method / URL / API Request ID…" aria-label="搜索请求历史" />
          </label>
          <select className="run-filter" aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部状态</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <button type="button" className={`lib-hbtn${pinnedOnly ? ' active' : ''}`} aria-pressed={pinnedOnly} onClick={() => setPinnedOnly((value) => !value)}>
            <IconPin size={12} /> 仅看 pinned
          </button>
          <button type="button" className="lib-hbtn" aria-label="刷新请求历史" onClick={() => void loadRuns()} disabled={listState === 'loading' || listState === 'refreshing'}>
            <IconRefresh size={12} /> 刷新
          </button>
          <button type="button" className="lib-close" aria-label="关闭请求历史" onClick={onClose}><IconX size={15} /></button>
        </div>

        {showLoading && <div className="catalog-status" role="status"><IconLoader2 className="catalog-spinner" size={14} /><span>加载请求历史…</span></div>}
        {showOffline && (
          <div className="catalog-status" role="alert"><span>暂时无法加载请求历史</span><button type="button" className="catalog-retry" onClick={() => void loadRuns()}><IconRefresh size={12} /> Retry</button></div>
        )}
        {showError && (
          <div className="catalog-status" role="alert"><span>{error ?? '加载请求历史失败'}</span><button type="button" className="catalog-retry" onClick={() => void loadRuns()}><IconRefresh size={12} /> Retry</button></div>
        )}
        {pinError && <div className="catalog-status inline" role="alert"><span>{pinError}</span></div>}

        {!showLoading && !showOffline && !showError && (
          <div className="lib-body">
            <div className="col-apis run-list-col">
              <div className="col-apis-head"><span className="col-apis-title">Runs（{filtered.length}）</span></div>
              <div className="api-list">
                {showEmpty && <div className="api-list-empty">还没有运行记录</div>}
                {!showEmpty && filtered.length === 0 && <div className="api-list-empty">没有匹配的运行记录</div>}
                {filtered.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className={`run-it${run.id === selectedRunId ? ' active' : ''}`}
                    onClick={() => void selectRun(run.id)}
                  >
                    <span className="run-it-top">
                      <span className={`api-m am-${run.request_snapshot.method.toLowerCase()}`}>{run.request_snapshot.method === 'DELETE' ? 'DEL' : run.request_snapshot.method}</span>
                      <span className="run-it-url">{run.request_snapshot.url}</span>
                      {run.is_pinned && <IconPinnedFilled size={12} className="run-pin-mark" aria-label="已固定" />}
                    </span>
                    <span className="run-it-meta">
                      <span className={`run-st ${statusClass(run)}`}>{run.status}</span>
                      {run.response_status != null && <span className="run-code">{run.response_status}</span>}
                      <span className="run-dim">{formatClock(run.started_at)}</span>
                      <span className="run-dim">{formatDuration(run.duration_ms)}</span>
                    </span>
                    {run.error_message && <span className="run-it-err"><IconAlertTriangle size={11} /> {run.error_code ? `${run.error_code}: ` : ''}{run.error_message}</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-det run-detail-col">
              {detail ? (
                <div className="run-detail">
                  <div className="run-detail-head">
                    <div className="det-mrow">
                      <span className={`det-method am-${detail.request_snapshot.method.toLowerCase()}`}>{detail.request_snapshot.method}</span>
                      <span className="det-url">{detail.request_snapshot.url}</span>
                    </div>
                    <div className="run-detail-acts">
                      {onRerun && (
                        <button type="button" className="det-btn" onClick={() => requestRerun(detail)}>
                          <IconPlayerPlay size={12} /> 再次执行
                        </button>
                      )}
                      <button type="button" className="det-btn" aria-label={detail.is_pinned ? '取消固定' : '固定'} aria-pressed={detail.is_pinned} onClick={() => void handleTogglePin(detail.id)}>
                        {detail.is_pinned ? <IconPinnedFilled size={12} /> : <IconPin size={12} />} {detail.is_pinned ? '已固定' : '固定'}
                      </button>
                      <button type="button" className="det-btn det-btn-danger" onClick={() => { setDeleteError(null); setDeleteTarget(detail) }}><IconTrash size={12} /> 删除</button>
                    </div>
                  </div>

                  {detailState === 'loading' && <div className="catalog-status inline" role="status"><IconLoader2 className="catalog-spinner" size={13} /><span>加载详情…</span></div>}
                  {detailError && <div className="catalog-status inline" role="alert"><span>{detailError}</span></div>}

                  <div className="run-detail-body">
                    <div className="run-stat-row">
                      <span className={`run-st ${statusClass(detail)}`}>{detail.status}</span>
                      {detail.response_status != null && <span className="run-code">HTTP {detail.response_status}</span>}
                      <span className="run-dim">{formatDuration(detail.duration_ms)}</span>
                      <span className="run-dim">{formatSize(detail.response_size)}</span>
                    </div>
                    <div className="run-time-row">
                      <span>开始 {formatTimestamp(detail.started_at)}</span>
                      {detail.finished_at && <span>结束 {formatTimestamp(detail.finished_at)}</span>}
                    </div>

                    {(detail.error_code || detail.error_message) && (
                      <div className="run-error-card" role="alert">
                        <IconAlertTriangle size={13} />
                        <div><strong>{detail.error_code || 'transport_error'}</strong>{detail.error_message && <div>{detail.error_message}</div>}</div>
                      </div>
                    )}

                    <div className="run-section">
                      <div className="dp-lbl">Request</div>
                      <KeyValueList label="Query" rows={detail.request_snapshot.query_params} />
                      <KeyValueList label="Headers" rows={detail.request_snapshot.headers} />
                      {detail.request_snapshot.body && (
                        <>
                          <div className="dp-lbl">Body</div>
                          <pre className="run-pre">{formatJson(detail.request_snapshot.body)}</pre>
                        </>
                      )}
                    </div>

                    <div className="run-section">
                      <div className="dp-lbl">Response</div>
                      {detail.response_truncated && <div className="run-trunc"><IconAlertTriangle size={11} /> 响应体过大，已截断显示。</div>}
                      {detail.response_headers != null && String(formatJson(detail.response_headers)).trim() !== 'null' && (
                        <>
                          <div className="run-sub-lbl">Headers</div>
                          <pre className="run-pre">{formatJson(detail.response_headers)}</pre>
                        </>
                      )}
                      <div className="run-sub-lbl">Body</div>
                      <pre className="run-pre">{formatJson(detail.response_body) || '（空）'}</pre>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="det-empty">
                  <IconSearch size={26} />
                  <p>{showEmpty ? '还没有运行记录' : '选择左侧的一条运行记录'}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="lib-confirm-overlay" role="presentation">
            <div className="lib-confirm" role="alertdialog" aria-modal="true" aria-label="确认删除运行记录">
              <div className="lib-confirm-icon"><IconTrash size={18} /></div>
              <div className="lib-confirm-title">删除运行记录</div>
              <p className="lib-confirm-body">
                确认删除 <strong>{deleteTarget.request_snapshot.method} {deleteTarget.request_snapshot.url}</strong> 的运行记录？此操作不可恢复。
              </p>
              {deleteError && <div className="lib-confirm-error"><IconAlertTriangle size={12} /> {deleteError}</div>}
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
                <button type="button" className="ed-btn primary danger" onClick={() => void confirmDelete()} disabled={deleting}>
                  {deleting ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          </div>
        )}
        {rerunTarget && currentFlowName != null && (
          <div className="lib-confirm-overlay" role="presentation">
            <div className="lib-confirm" role="dialog" aria-modal="true" aria-label="选择再次执行的位置">
              <div className="lib-confirm-icon run-rerun-icon"><IconPlayerPlay size={18} /></div>
              <div className="lib-confirm-title">添加到当前 Flow？</div>
              <p className="lib-confirm-body">
                是否将 <strong>{rerunTarget.request_snapshot.method} {rerunTarget.request_snapshot.url}</strong> 添加到
                当前 Flow「{currentFlowName}」？
              </p>
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => setRerunTarget(null)}>取消</button>
                <button type="button" className="ed-btn" onClick={() => confirmRerun('scratch')}>在 Scratch 中打开</button>
                <button type="button" className="ed-btn primary" onClick={() => confirmRerun('flow')}>添加到当前 Flow</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
