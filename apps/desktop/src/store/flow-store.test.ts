import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_DEBOUNCE_MS, useFlowStore } from './flow-store'
import type { Flow } from '../services/flow-client'

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'f1',
    project_id: 'default',
    name: 'Untitled flow',
    description: '',
    environment_id: null,
    settings: { stop_on_error: true, request_timeout_ms: 60000 },
    variables: [],
    steps: [],
    edit_version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function resetStore() {
  useFlowStore.setState({
    summaries: [], entities: {}, drafts: {}, selectedFlowId: null,
    listState: 'idle', saveStateById: {}, errorById: {},
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStore()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('flow-store new flow', () => {
  it('only shows a flow after the backend confirms creation', async () => {
    const created = makeFlow({ id: 'new-1', name: 'Untitled flow' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(201, created)))

    const promise = useFlowStore.getState().createFlow()
    await vi.runAllTimersAsync()
    await promise

    const state = useFlowStore.getState()
    expect(state.summaries.map((s) => s.id)).toEqual(['new-1'])
    expect(state.selectedFlowId).toBe('new-1')
    expect(state.saveStateById['new-1']).toBe('saved')
  })
})

describe('flow-store autosave', () => {
  it('transitions dirty → saving → saved and bumps edit_version', async () => {
    const flow = makeFlow({ id: 'f1', edit_version: 1 })
    useFlowStore.setState({
      entities: { f1: flow }, drafts: { f1: flow }, saveStateById: { f1: 'saved' }, selectedFlowId: 'f1',
      summaries: [{
        id: 'f1', project_id: 'default', name: 'Untitled flow', description: '', environment_id: null,
        step_count: 0, edit_version: 1, created_at: '', updated_at: '', archived_at: null,
      }],
    })
    const saved = makeFlow({ id: 'f1', name: 'Renamed', edit_version: 2 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, saved)))

    useFlowStore.getState().updateDraft('f1', (d) => ({ ...d, name: 'Renamed' }))
    expect(useFlowStore.getState().saveStateById['f1']).toBe('dirty')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 5)

    const state = useFlowStore.getState()
    expect(state.saveStateById['f1']).toBe('saved')
    expect(state.entities['f1'].edit_version).toBe(2)
    expect(state.summaries.find((s) => s.id === 'f1')?.name).toBe('Renamed')
  })

  it('keeps the local draft and marks error on save failure, then retries', async () => {
    const flow = makeFlow({ id: 'f1' })
    useFlowStore.setState({ entities: { f1: flow }, drafts: { f1: flow }, saveStateById: { f1: 'saved' }, selectedFlowId: 'f1' })

    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    useFlowStore.getState().updateDraft('f1', (d) => ({ ...d, name: 'Edited' }))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 5)

    let state = useFlowStore.getState()
    expect(state.saveStateById['f1']).toBe('error')
    expect(state.drafts['f1'].name).toBe('Edited') // draft preserved

    // Retry succeeds.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeFlow({ id: 'f1', name: 'Edited', edit_version: 2 })))
    const promise = useFlowStore.getState().flushSave('f1')
    await vi.runAllTimersAsync()
    await promise

    state = useFlowStore.getState()
    expect(state.saveStateById['f1']).toBe('saved')
    expect(state.entities['f1'].name).toBe('Edited')
  })

  it('marks conflict without overwriting the local draft on 409', async () => {
    const flow = makeFlow({ id: 'f1', edit_version: 1 })
    useFlowStore.setState({ entities: { f1: flow }, drafts: { f1: flow }, saveStateById: { f1: 'saved' }, selectedFlowId: 'f1' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, {
      error: 'flow version conflict',
      current: { id: 'f1', edit_version: 5, updated_at: '2026-02-02T00:00:00Z' },
    })))

    useFlowStore.getState().updateDraft('f1', (d) => ({ ...d, name: 'Local edit' }))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 5)

    const state = useFlowStore.getState()
    expect(state.saveStateById['f1']).toBe('conflict')
    expect(state.drafts['f1'].name).toBe('Local edit') // never clobbered
  })
})
