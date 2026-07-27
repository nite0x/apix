import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFlowRunStore } from './flow-run-store'
import { useFlowStore } from './flow-store'
import type { Flow, FlowRun } from '../services/flow-client'

function makeFlow(): Flow {
  return {
    id: 'f1', project_id: 'default', name: 'Flow', description: '', environment_id: null,
    settings: { stop_on_error: true, request_timeout_ms: 60000 }, variables: [], steps: [],
    edit_version: 3, created_at: '', updated_at: '', archived_at: null,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  useFlowRunStore.setState({ runsById: {}, runIdsByFlow: {}, activeRunId: null, startState: 'idle', startError: undefined })
  useFlowStore.setState({ entities: {}, drafts: {}, saveStateById: {}, summaries: [], selectedFlowId: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('flow-run-store startRun', () => {
  it('does not start a run when the flush leaves the flow in error state', async () => {
    const flow = makeFlow()
    useFlowStore.setState({ drafts: { f1: flow }, saveStateById: { f1: 'error' } })
    // flushSave resolves undefined without changing the error state.
    vi.spyOn(useFlowStore.getState(), 'flushSave').mockResolvedValue(undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const run = await useFlowRunStore.getState().startRun(flow)

    expect(run).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useFlowRunStore.getState().startState).toBe('error')
  })

  it('starts a run and records it as active on success', async () => {
    const flow = makeFlow()
    useFlowStore.setState({ drafts: { f1: flow }, saveStateById: { f1: 'saved' } })
    vi.spyOn(useFlowStore.getState(), 'flushSave').mockResolvedValue(flow)

    const run: FlowRun = {
      id: 'run-1', project_id: 'default', flow_id: 'f1', flow_version: 3, flow_name_snapshot: 'Flow',
      environment_id: null, trigger_type: 'manual', status: 'queued', current_step: 0, total_steps: 1,
      created_at: '', started_at: null, finished_at: null, steps: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(202, run)))

    const result = await useFlowRunStore.getState().startRun(flow)

    expect(result?.id).toBe('run-1')
    expect(useFlowRunStore.getState().activeRunId).toBe('run-1')
    expect(useFlowRunStore.getState().runsById['run-1'].status).toBe('queued')
  })
})

describe('flow-run-store applyEvent', () => {
  it('updates step status from a step_finished event', () => {
    const run: FlowRun = {
      id: 'run-1', project_id: 'default', flow_id: 'f1', flow_version: 3, flow_name_snapshot: 'Flow',
      environment_id: null, trigger_type: 'manual', status: 'running', current_step: 0, total_steps: 1,
      created_at: '', started_at: null, finished_at: null,
      steps: [{
        id: 's1', flow_run_id: 'run-1', flow_step_id: null, position: 0, name_snapshot: 'a',
        request_snapshot: { method: 'GET', url: 'x' }, status: 'running', api_run_id: null, started_at: null, finished_at: null,
      }],
    }
    useFlowRunStore.setState({ runsById: { 'run-1': run } })

    useFlowRunStore.getState().applyEvent({
      type: 'flow_run.step_finished', session_id: 'run-1', step_id: 's1', payload: { status: 'succeeded' },
    })

    expect(useFlowRunStore.getState().runsById['run-1'].steps?.[0].status).toBe('succeeded')
  })
})
