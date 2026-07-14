import { useCallback, useEffect, useMemo, useState } from 'react'
import { fixtureCatalog, allApis, type ApiCollectionGroup, type ApiDefinition } from '../../data/api-catalog'
import { useWebSocket } from '../../hooks/use-websocket'
import { loadCatalog, resumeStep } from '../../services/api-client'
import { useSessionStore, type Step } from '../../store/session-store'
import { ApiDrawer } from '../api/api-drawer'
import { ApiLibrary } from '../api/api-library'
import { RequestPicker } from '../request-picker/request-picker'
import { SessionPanel } from '../right-panel/session-panel'
import { ApiSearch } from '../search/api-search'
import { Sidebar } from '../sidebar/sidebar'
import { Timeline } from '../timeline/timeline'
import { Topbar } from '../topbar/topbar'

interface DrawerState {
  api: ApiDefinition
  source: 'run' | 'library'
  step?: Step
}
interface PickerState {
  mode: 'flow' | 'step'
  targetStepId?: string
}

function comparablePath(value?: string) {
  if (!value) return ''
  return value.replace('{{base_url}}', '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/:\w+/g, '')
}

export function Shell() {
  useWebSocket()

  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const startNewFlow = useSessionStore((state) => state.startNewFlow)
  const appendManualStep = useSessionStore((state) => state.appendManualStep)
  const configureManualStep = useSessionStore((state) => state.configureManualStep)
  const resolvePausedStep = useSessionStore((state) => state.resolvePausedStep)
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null

  const [catalog, setCatalog] = useState<ApiCollectionGroup[]>(fixtureCatalog)
  const [overlay, setOverlay] = useState<'library' | 'search' | null>(null)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [panelTab, setPanelTab] = useState<'session' | 'rules'>('session')

  useEffect(() => { void loadCatalog().then(setCatalog) }, [])

  const closeLayers = useCallback(() => {
    setOverlay(null)
    setDrawer(null)
    setPicker(null)
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT'
      if (event.key === 'Escape') closeLayers()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDrawer(null)
        setPicker(null)
        setOverlay('search')
      }
      if (!isTyping && event.key.toLowerCase() === 'n' && activeSession) {
        event.preventDefault()
        setOverlay(null)
        setDrawer(null)
        setPicker({ mode: 'step' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSession, closeLayers])

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
    setPicker(null)
    setDrawer({ api, source: 'run', step })
  }

  function openLibrary() {
    setDrawer(null)
    setPicker(null)
    setOverlay('library')
  }

  function openSearch() {
    setDrawer(null)
    setPicker(null)
    setOverlay('search')
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
      // Demo sessions intentionally keep the interaction usable while the runtime is offline.
    }
    resolvePausedStep(activeSession.id, step.id, action)
  }

  function startFlow() {
    closeLayers()
    startNewFlow()
    setPanelTab('session')
  }

  function handlePickerSelection(selection: { method: string; url: string; api?: ApiDefinition }) {
    if (!activeSession && picker?.mode === 'step') return
    if (picker?.mode === 'flow') {
      const sessionId = activeSession?.status === 'draft' ? activeSession.id : startNewFlow()
      const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
      const stepId = picker.targetStepId ?? session?.steps[0]?.id
      if (stepId) configureManualStep(sessionId, stepId, { method: selection.method, url: selection.url, apiRequestId: selection.api?.id })
    } else if (activeSession) {
      appendManualStep(activeSession.id, { method: selection.method, url: selection.url, apiRequestId: selection.api?.id })
    }
    setPicker(null)
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
      <Sidebar onNewFlow={startFlow} onOpenRules={() => setPanelTab('rules')} onOpenVariables={() => setPanelTab('session')} />
      <main className="main" id="main">
        <Topbar session={activeSession} onReview={reviewCurrentStep} onStop={stopCurrentStep} onSearch={openSearch} onLibrary={openLibrary} />
        <div className="tl-wrap">
          {activeSession ? (
            <Timeline
              session={activeSession}
              onOpenApi={openStepApi}
              onAddStep={() => setPicker({ mode: 'step' })}
              onChooseDraftApi={(_sessionId, stepId) => setPicker({ mode: 'flow', targetStepId: stepId })}
              onResolvePaused={(action, step, modifiedRequest) => void resolveStep(action, step, modifiedRequest)}
            />
          ) : <div className="tl-empty">Select a session from the sidebar</div>}
          <SessionPanel session={activeSession} activeTab={panelTab} onTabChange={setPanelTab} />
        </div>

        {overlay === 'search' && <ApiSearch catalog={catalog} onClose={() => setOverlay(null)} onSelect={selectSearchApi} />}
        {overlay === 'library' && <ApiLibrary catalog={catalog} onClose={() => setOverlay(null)} onJumpToSession={() => setOverlay(null)} />}
        {drawer && <ApiDrawer {...drawer} onClose={() => setDrawer(null)} onJumpToSession={() => setDrawer(null)} />}
        {picker && <RequestPicker mode={picker.mode} catalog={catalog} onClose={() => setPicker(null)} onSelect={handlePickerSelection} />}
      </main>
    </div>
  )
}
