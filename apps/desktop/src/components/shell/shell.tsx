import { useCallback, useEffect, useMemo, useState } from 'react'
import { allApis, type ApiDefinition } from '../../data/api-catalog'
import { useWebSocket } from '../../hooks/use-websocket'
import { resumeStep } from '../../services/api-client'
import { useCatalogStore } from '../../store/catalog-store'
import { useRuleStore } from '../../store/rule-store'
import { useRuntimeStatusStore } from '../../store/runtime-status-store'
import { useSessionStore, type Step } from '../../store/session-store'
import { useFlowStore } from '../../store/flow-store'
import { useFlowRunStore } from '../../store/flow-run-store'
import { ApiDrawer } from '../api/api-drawer'
import { ApiLibrary } from '../api/api-library'
import { SessionPanel } from '../right-panel/session-panel'
import { RulesManager } from '../rules/rules-manager'
import { RunHistory } from '../runs/run-history'
import { ApiSearch } from '../search/api-search'
import { Sidebar } from '../sidebar/sidebar'
import { Timeline } from '../timeline/timeline'
import { Topbar } from '../topbar/topbar'
import { createBlankFlowStep, FlowEditor } from '../flow/flow-editor'
import { FlowRunView } from '../flow/flow-run-view'
import { FlowDeleteDialog } from '../flow/flow-delete-dialog'

interface DrawerState {
  api: ApiDefinition
  source: 'run' | 'library'
  step?: Step
}

function comparablePath(value?: string) {
  if (!value) return ''
  return value.replace('{{base_url}}', '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/:\w+/g, '')
}

export function Shell() {
  useWebSocket()

  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const loadState = useSessionStore((s) => s.loadState)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const appendManualStep = useSessionStore((s) => s.appendManualStep)
  const resolvePausedStep = useSessionStore((s) => s.resolvePausedStep)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  const catalog = useCatalogStore((s) => s.groups)
  const catalogState = useCatalogStore((s) => s.loadState)
  const catalogError = useCatalogStore((s) => s.error)
  const isPreviewCatalog = useCatalogStore((s) => s.isPreview)
  const refreshCatalog = useCatalogStore((s) => s.refresh)
  const runCatalogMutation = useCatalogStore((s) => s.runMutation)

  const loadRules = useRuleStore((s) => s.loadRules)
  const checkHealth = useRuntimeStatusStore((s) => s.checkHealth)

  const loadFlows = useFlowStore((s) => s.loadFlows)
  const createFlow = useFlowStore((s) => s.createFlow)
  const selectFlow = useFlowStore((s) => s.selectFlow)
  const renameFlow = useFlowStore((s) => s.renameFlow)
  const deleteFlowAction = useFlowStore((s) => s.deleteFlow)
  const restoreFlow = useFlowStore((s) => s.restoreFlow)
  const saveStateById = useFlowStore((s) => s.saveStateById)
  const selectedFlowId = useFlowStore((s) => s.selectedFlowId)
  const flowDraft = useFlowStore((s) => (s.selectedFlowId ? s.drafts[s.selectedFlowId] : undefined))
  const flushSave = useFlowStore((s) => s.flushSave)
  const updateFlowDraft = useFlowStore((s) => s.updateDraft)
  const activeRunId = useFlowRunStore((s) => s.activeRunId)
  const activeRun = useFlowRunStore((s) => (s.activeRunId ? s.runsById[s.activeRunId] : undefined))

  const [overlay, setOverlay] = useState<'library' | 'search' | 'rules' | 'runs' | null>(null)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [panelTab, setPanelTab] = useState<'session' | 'rules'>('session')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [undoFlow, setUndoFlow] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    void loadFlows()
  }, [loadFlows])

  useEffect(() => {
    void refreshCatalog()
  }, [refreshCatalog])

  useEffect(() => {
    // One-time startup connectivity probe and rule load (drives the sidebar count).
    void checkHealth()
    void loadRules()
  }, [checkHealth, loadRules])

  const closeLayers = useCallback(() => {
    setOverlay(null)
    setDrawer(null)
  }, [])

  const addBlankStep = useCallback(() => {
    if (selectedFlowId && flowDraft) {
      updateFlowDraft(selectedFlowId, (draft) => ({
        ...draft,
        steps: [...draft.steps, createBlankFlowStep(draft.steps.length)],
      }))
      return
    }
    if (activeSession) appendManualStep(activeSession.id)
  }, [activeSession, appendManualStep, selectedFlowId, flowDraft, updateFlowDraft])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT'
      if (event.key === 'Escape') closeLayers()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        // Cmd/Ctrl+S saves the open flow immediately.
        if (selectedFlowId) {
          event.preventDefault()
          void flushSave(selectedFlowId)
          return
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDrawer(null)
        setOverlay('search')
      }
      if (!isTyping && event.key.toLowerCase() === 'n' && (activeSession || selectedFlowId)) {
        event.preventDefault()
        setOverlay(null)
        setDrawer(null)
        addBlankStep()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSession, closeLayers, addBlankStep, selectedFlowId, flushSave])

  useEffect(() => {
    // Warn before leaving with unsaved/failed flow edits.
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      const unsaved = Object.values(saveStateById).some((state) => state === 'dirty' || state === 'saving' || state === 'error' || state === 'conflict')
      if (unsaved) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [saveStateById])

  const flatApis = useMemo(() => allApis(catalog), [catalog])

  function findApiForStep(step: Step) {
    return flatApis.find((api) => api.id === step.apiRequestId)
      ?? flatApis.find((api) => api.method === step.method && comparablePath(step.url).startsWith(comparablePath(api.url)))
      ?? flatApis.find((api) => api.method === step.method)
      ?? flatApis[0]
  }

  function openStepApi(step: Step) {
    const api = findApiForStep(step)
    if (!api) return
    setOverlay(null)
    setDrawer({ api, source: 'run', step })
  }

  function openLibrary() {
    setDrawer(null)
    setOverlay('library')
  }

  function openSearch() {
    setDrawer(null)
    setOverlay('search')
  }

  function openRules() {
    setDrawer(null)
    setOverlay('rules')
  }

  function openRunHistory() {
    setDrawer(null)
    setOverlay('runs')
  }

  function selectSearchApi(api: ApiDefinition) {
    setOverlay(null)
    if (selectedFlowId && flowDraft) {
      const request = api.requestData ?? {
        method: api.method,
        url: api.url,
        query_params: [],
        headers: [],
        body_type: 'none',
        body: '',
      }
      updateFlowDraft(selectedFlowId, (draft) => ({
        ...draft,
        steps: [
          ...draft.steps,
          {
            ...createBlankFlowStep(draft.steps.length),
            name: request.url ? comparablePath(request.url) || request.url : api.name,
            source_api_request_id: api.source === 'backend' ? api.id : null,
            request,
          },
        ],
      }))
      return
    }
    setDrawer({ api, source: 'library' })
  }

  function openFlowAPI(requestId: string) {
    const api = flatApis.find((item) => item.id === requestId)
    if (api) setDrawer({ api, source: 'library' })
  }

  async function resolveStep(action: 'continue' | 'skip' | 'stop', step: Step, modifiedRequest?: string) {
    if (!activeSession) return
    try {
      await resumeStep(step.id, action, modifiedRequest ? { raw_request: modifiedRequest } : undefined)
    } catch {
      // Keep the UI usable when the runtime is offline (e.g. draft/local-only flows).
    }
    resolvePausedStep(activeSession.id, step.id, action)
  }

  async function startFlow() {
    closeLayers()
    // Create a durable Flow on the backend so a refresh never loses it.
    try {
      await createFlow()
    } catch {
      // Do not fabricate a local flow; the sidebar stays unchanged on failure.
    }
  }

  function openFlow(id: string) {
    closeLayers()
    useFlowRunStore.setState({ activeRunId: null })
    void selectFlow(id)
  }

  function requestRenameFlow(id: string) {
    const summary = useFlowStore.getState().summaries.find((s) => s.id === id)
    const next = window.prompt('Rename flow', summary?.name ?? '')
    if (next && next.trim()) void renameFlow(id, next)
  }

  function requestDeleteFlow(id: string) {
    const summary = useFlowStore.getState().summaries.find((s) => s.id === id)
    setDeleteTarget({ id, name: summary?.name ?? 'this flow' })
  }

  async function confirmDeleteFlow() {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    await deleteFlowAction(target.id)
    setUndoFlow(target)
    window.setTimeout(() => {
      setUndoFlow((current) => (current?.id === target.id ? null : current))
    }, 6000)
  }

  function undoDelete() {
    if (!undoFlow) return
    void restoreFlow(undoFlow.id)
    setUndoFlow(null)
  }

  const showFlowRun = !!activeRun && activeRun.flow_id === selectedFlowId
  const flowOpen = !!selectedFlowId && !!flowDraft

  function reviewCurrentStep() {
    const paused = activeSession?.steps.find((step) => step.status === 'paused')
    if (paused) document.getElementById(`step-${paused.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function stopCurrentStep() {
    const paused = activeSession?.steps.find((step) => step.status === 'paused')
    if (paused) void resolveStep('stop', paused)
  }

  return (
    <div className="app">
      <Sidebar
        onNewFlow={() => void startFlow()}
        onOpenFlow={openFlow}
        onRenameFlow={requestRenameFlow}
        onDeleteFlow={requestDeleteFlow}
        onOpenRules={openRules}
        onOpenVariables={() => setPanelTab('session')}
        onOpenRunHistory={openRunHistory}
      />
      <main className="main" id="main">
        {flowOpen && flowDraft ? (
          <div className="tl-wrap flow-wrap">
            {showFlowRun && activeRunId ? (
              <FlowRunView runId={activeRunId} onBack={() => useFlowRunStore.setState({ activeRunId: null })} />
            ) : (
              <FlowEditor
                flow={flowDraft}
                onSearch={openSearch}
                onLibrary={openLibrary}
                onRunHistory={openRunHistory}
                onChooseAPI={openSearch}
                onOpenAPI={openFlowAPI}
                onManageRules={openRules}
              />
            )}
          </div>
        ) : (
          <>
            <Topbar
              session={activeSession}
              onReview={reviewCurrentStep}
              onStop={stopCurrentStep}
              onSearch={openSearch}
              onLibrary={openLibrary}
              onRunHistory={openRunHistory}
            />
            <div className="tl-wrap">
              {loadState === 'loading' && !activeSession ? (
                <div className="tl-empty">Loading sessions...</div>
              ) : activeSession ? (
                <Timeline
                  session={activeSession}
                  onOpenApi={openStepApi}
                  onAddStep={addBlankStep}
                  onResolvePaused={(action, step, modifiedRequest) => void resolveStep(action, step, modifiedRequest)}
                />
              ) : loadState === 'error' ? (
                <div className="tl-empty">Runtime unavailable</div>
              ) : (
                <div className="tl-empty">No sessions yet</div>
              )}
              <SessionPanel session={activeSession} activeTab={panelTab} onTabChange={setPanelTab} onManageRules={openRules} />
            </div>
          </>
        )}

        {overlay === 'search' && (
          <ApiSearch
            catalog={catalog}
            catalogState={catalogState}
            catalogError={catalogError}
            isPreview={isPreviewCatalog}
            onRetry={() => void refreshCatalog()}
            onClose={() => setOverlay(null)}
            onSelect={selectSearchApi}
          />
        )}
        {overlay === 'library' && (
          <ApiLibrary
            catalog={catalog}
            catalogState={catalogState}
            catalogError={catalogError}
            isPreview={isPreviewCatalog}
            onClose={() => setOverlay(null)}
            onJumpToSession={() => setOverlay(null)}
            onRetry={() => void refreshCatalog()}
            onCatalogMutation={runCatalogMutation}
          />
        )}
        {overlay === 'rules' && <RulesManager onClose={() => setOverlay(null)} />}
        {overlay === 'runs' && <RunHistory onClose={() => setOverlay(null)} />}
        {drawer && <ApiDrawer {...drawer} onClose={() => setDrawer(null)} onJumpToSession={() => setDrawer(null)} />}
        {deleteTarget && (
          <FlowDeleteDialog
            flowName={deleteTarget.name}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => void confirmDeleteFlow()}
          />
        )}
        {undoFlow && (
          <div className="flow-undo-toast" role="status">
            <span>Deleted “{undoFlow.name}”.</span>
            <button type="button" className="linkish" onClick={undoDelete}>Undo</button>
          </div>
        )}
      </main>
    </div>
  )
}
