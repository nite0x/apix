import { useCallback, useEffect, useMemo, useState } from 'react'
import { allApis, type ApiDefinition } from '../../data/api-catalog'
import { useWebSocket } from '../../hooks/use-websocket'
import { resumeStep } from '../../services/api-client'
import { useCatalogStore } from '../../store/catalog-store'
import { useRuleStore } from '../../store/rule-store'
import { useRuntimeStatusStore } from '../../store/runtime-status-store'
import { useSessionStore, type Step } from '../../store/session-store'
import { ApiDrawer } from '../api/api-drawer'
import { ApiLibrary } from '../api/api-library'
import { SessionPanel } from '../right-panel/session-panel'
import { RulesManager } from '../rules/rules-manager'
import { RunHistory } from '../runs/run-history'
import { ApiSearch } from '../search/api-search'
import { Sidebar } from '../sidebar/sidebar'
import { Timeline } from '../timeline/timeline'
import { Topbar } from '../topbar/topbar'

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
  const startNewFlow = useSessionStore((s) => s.startNewFlow)
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

  const [overlay, setOverlay] = useState<'library' | 'search' | 'rules' | 'runs' | null>(null)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [panelTab, setPanelTab] = useState<'session' | 'rules'>('session')

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

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
    if (activeSession) appendManualStep(activeSession.id)
  }, [activeSession, appendManualStep])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT'
      if (event.key === 'Escape') closeLayers()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDrawer(null)
        setOverlay('search')
      }
      if (!isTyping && event.key.toLowerCase() === 'n' && activeSession) {
        event.preventDefault()
        setOverlay(null)
        setDrawer(null)
        addBlankStep()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSession, closeLayers, addBlankStep])

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
    setDrawer({ api, source: 'library' })
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

  function startFlow() {
    closeLayers()
    startNewFlow()
    setPanelTab('session')
  }

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
      <Sidebar onNewFlow={startFlow} onOpenRules={openRules} onOpenVariables={() => setPanelTab('session')} onOpenRunHistory={openRunHistory} />
      <main className="main" id="main">
        <Topbar
          session={activeSession}
          onReview={reviewCurrentStep}
          onStop={stopCurrentStep}
          onSearch={openSearch}
          onLibrary={openLibrary}
          onRunHistory={openRunHistory}
          onRetryRuntime={() => void checkHealth()}
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
      </main>
    </div>
  )
}
