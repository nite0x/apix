import { useEffect, useState } from 'react'
import {
  IconChevronDown,
  IconCopy,
  IconArrowUp,
  IconArrowDown,
  IconTrash,
  IconPlus,
  IconLibrary,
} from '@tabler/icons-react'
import { useFlowStore } from '../../store/flow-store'
import type { Flow, FlowStep } from '../../services/flow-client'
import { RequestWorkbench } from '../request/request-workbench'
import { FlowPanel } from './flow-panel'
import { FlowTopbar } from './flow-topbar'

export function requestPath(url: string): string {
  const value = url.trim()
  if (!value) return 'New request'
  try {
    const parsed = new URL(value)
    return parsed.pathname || '/'
  } catch {
    const withoutOrigin = value
      .replace(/^\{\{[^}]+}}/, '')
      .replace(/^https?:\/\/[^/]+/i, '')
      .split('?')[0]
    return withoutOrigin || value
  }
}

export function createBlankFlowStep(position: number): FlowStep {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    position,
    type: 'http',
    name: 'New request',
    enabled: true,
    source_api_request_id: null,
    request: { method: 'GET', url: '', query_params: [], headers: [], body_type: 'none', body: '' },
    config: { continue_on_error: false, extractors: [] },
  }
}

interface Props {
  flow: Flow
  onSearch: () => void
  onLibrary: () => void
  onRunHistory: () => void
  onChooseAPI?: () => void
  onOpenAPI?: (requestId: string) => void
  onManageRules?: () => void
}

export function FlowEditor({
  flow,
  onSearch,
  onLibrary,
  onRunHistory,
  onChooseAPI = () => {},
  onOpenAPI = () => {},
  onManageRules = () => {},
}: Props) {
  const updateDraft = useFlowStore((s) => s.updateDraft)

  useEffect(() => {
    if (flow.steps.length !== 0) return
    updateDraft(flow.id, (draft) => {
      if (draft.steps.length !== 0) return draft
      return { ...draft, steps: [createBlankFlowStep(0)] }
    })
  }, [flow.id, flow.steps.length, updateDraft])

  function mutateSteps(mutator: (steps: FlowStep[]) => FlowStep[]) {
    updateDraft(flow.id, (draft) => {
      const steps = mutator(draft.steps.map((s) => ({ ...s }))).map((s, i) => ({ ...s, position: i }))
      return { ...draft, steps }
    })
  }

  function patchStep(id: string, patch: Partial<FlowStep>) {
    mutateSteps((steps) => steps.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function patchRequest(id: string, patch: Partial<FlowStep['request']>) {
    mutateSteps((steps) => steps.map((s) => (s.id === id ? { ...s, request: { ...s.request, ...patch } } : s)))
  }

  return (
    <div className="flow-editor">
      <FlowTopbar
        flow={flow}
        onSearch={onSearch}
        onLibrary={onLibrary}
        onRunHistory={onRunHistory}
      />
      <div className="flow-editor-content">
        <div className="tl flow-timeline">
          {flow.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            index={index}
            total={flow.steps.length}
            onToggle={() => patchStep(step.id, { enabled: !step.enabled })}
            onRequest={(request) =>
              mutateSteps((steps) => steps.map((item) =>
                item.id === step.id
                  ? { ...item, name: requestPath(request.url), request }
                  : item,
              ))
            }
            onContinueOnError={(value) => patchStep(step.id, { config: { ...step.config, continue_on_error: value } })}
            onLinkAPI={(requestId) => patchStep(step.id, { source_api_request_id: requestId })}
            onOpenAPI={() => step.source_api_request_id && onOpenAPI(step.source_api_request_id)}
            onMove={(dir) =>
              mutateSteps((steps) => {
                const target = index + dir
                if (target < 0 || target >= steps.length) return steps
                const next = [...steps]
                ;[next[index], next[target]] = [next[target], next[index]]
                return next
              })
            }
            onDuplicate={() =>
              mutateSteps((steps) => {
                const copy = { ...step, id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
                const next = [...steps]
                next.splice(index + 1, 0, copy)
                return next
              })
            }
            onDelete={() => mutateSteps((steps) => steps.filter((s) => s.id !== step.id))}
          />
          ))}
          <div className="step flow-add-step-row">
            <div className="node n-manual" />
            <div className="flow-add-step-composer">
              <button
                type="button"
                className="flow-add-step-main"
                onClick={() => mutateSteps((steps) => [...steps, createBlankFlowStep(steps.length)])}
              >
                <span className="add-step-icon"><IconPlus size={13} /></span>
                <span className="add-step-copy">
                  <span className="add-step-title">Add next step</span>
                  <span className="add-step-sub">Create and open a blank API request.</span>
                </span>
                <kbd className="add-step-kbd">N</kbd>
              </button>
              <button type="button" className="flow-add-from-library" onClick={onChooseAPI}>
                <IconLibrary size={13} />
                从现有 API 库创建
              </button>
            </div>
          </div>
        </div>
        <FlowPanel flow={flow} onManageRules={onManageRules} />
      </div>
    </div>
  )
}

interface StepRowProps {
  step: FlowStep
  index: number
  total: number
  onToggle: () => void
  onRequest: (request: FlowStep['request']) => void
  onContinueOnError: (value: boolean) => void
  onLinkAPI: (requestId: string | null) => void
  onOpenAPI: () => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
  onDelete: () => void
}

function StepRow({
  step, index, total, onToggle, onRequest,
  onContinueOnError, onLinkAPI, onOpenAPI, onMove, onDuplicate, onDelete,
}: StepRowProps) {
  const [open, setOpen] = useState(step.request.url === '')
  const method = step.request.method.toUpperCase()
  const methodClass =
    method === 'GET' ? 'm-get'
      : method === 'POST' ? 'm-post'
        : method === 'PUT' || method === 'PATCH' ? 'm-put'
          : method === 'DELETE' ? 'm-del'
            : 'm-new'

  return (
    <div className={`step flow-definition-step${step.enabled ? '' : ' muted'}`}>
      <div className={`node ${step.enabled ? 'n-manual' : 'n-idle'}`} />
      <div className="card flow-definition-card">
        <div className="chead flow-definition-head" onClick={() => setOpen((value) => !value)}>
          <input
            type="checkbox"
            checked={step.enabled}
            onChange={(event) => { event.stopPropagation(); onToggle() }}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Enable ${step.name}`}
          />
          <span className={`chip ${methodClass}`}>{method}</span>
          <span className={step.request.url ? 'clbl' : 'clbl-dim'}>
            {requestPath(step.request.url)}
          </span>
          <div className="flow-step-ops" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => onMove(-1)} disabled={index === 0} title="Move up"><IconArrowUp size={13} /></button>
            <button type="button" onClick={() => onMove(1)} disabled={index === total - 1} title="Move down"><IconArrowDown size={13} /></button>
            <button type="button" onClick={onDuplicate} title="Duplicate"><IconCopy size={13} /></button>
            <button type="button" onClick={onDelete} title="Delete"><IconTrash size={13} /></button>
          </div>
          <IconChevronDown size={13} className={`chev${open ? ' open' : ''}`} />
        </div>
        {open && (
          <div className="cbody flow-card-body">
            <RequestWorkbench
              request={step.request}
              sourceApiRequestId={step.source_api_request_id}
              onChange={onRequest}
              onSourceApiRequestIdChange={onLinkAPI}
              onOpenAPI={step.source_api_request_id ? onOpenAPI : undefined}
              compact
              autosaveWorkingCopy={false}
            />
            <label className="flow-step-check">
              <input type="checkbox" checked={step.config.continue_on_error} onChange={(e) => onContinueOnError(e.target.checked)} />
              Continue on error
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
