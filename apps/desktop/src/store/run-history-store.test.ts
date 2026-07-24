import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendRun } from '../services/api-client'
import { useRunHistoryStore } from './run-history-store'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function run(overrides: Partial<BackendRun> = {}): BackendRun {
  return {
    id: 'run-1',
    project_id: 'default',
    trigger_type: 'manual',
    status: 'succeeded',
    request_snapshot: { method: 'GET', url: 'https://api.example.com/users' },
    response_status: 200,
    response_truncated: false,
    is_pinned: false,
    started_at: '2026-07-24T10:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  useRunHistoryStore.setState({
    runs: [],
    selectedRunId: null,
    detail: null,
    listState: 'idle',
    detailState: 'idle',
    error: null,
    detailError: null,
    loaded: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('run history list', () => {
  it('loads runs and reports empty when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])))
    await useRunHistoryStore.getState().loadRuns()
    expect(useRunHistoryStore.getState()).toMatchObject({ listState: 'empty', loaded: true })
  })

  it('marks the list offline on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await useRunHistoryStore.getState().loadRuns()
    expect(useRunHistoryStore.getState().listState).toBe('offline')
  })

  it('surfaces server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)))
    await useRunHistoryStore.getState().loadRuns()
    expect(useRunHistoryStore.getState().listState).toBe('error')
  })

  it('refreshIfLoaded only refetches after the first load', () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([run()]))
    vi.stubGlobal('fetch', fetchMock)
    // Not loaded yet → no request.
    useRunHistoryStore.getState().refreshIfLoaded()
    expect(fetchMock).not.toHaveBeenCalled()
    useRunHistoryStore.setState({ loaded: true })
    useRunHistoryStore.getState().refreshIfLoaded()
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('run selection and detail', () => {
  it('loads the detail via getRun', async () => {
    const detail = run({ response_body: { ok: true } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)))
    useRunHistoryStore.setState({ runs: [run()] })

    await useRunHistoryStore.getState().selectRun('run-1')

    expect(useRunHistoryStore.getState().detailState).toBe('ready')
    expect(useRunHistoryStore.getState().detail?.id).toBe('run-1')
  })

  it('keeps the list snapshot if the detail refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    useRunHistoryStore.setState({ runs: [run()] })

    await useRunHistoryStore.getState().selectRun('run-1')

    // Snapshot from the list keeps the detail usable.
    expect(useRunHistoryStore.getState().detail?.id).toBe('run-1')
    expect(useRunHistoryStore.getState().detailState).toBe('ready')
  })
})

describe('pin and delete', () => {
  it('optimistically pins then persists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    useRunHistoryStore.setState({ runs: [run({ is_pinned: false })] })

    await useRunHistoryStore.getState().togglePinned('run-1')

    expect(useRunHistoryStore.getState().runs[0].is_pinned).toBe(true)
  })

  it('rolls back the pin when the runtime rejects it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    useRunHistoryStore.setState({ runs: [run({ is_pinned: false })] })

    await expect(useRunHistoryStore.getState().togglePinned('run-1')).rejects.toThrow()
    expect(useRunHistoryStore.getState().runs[0].is_pinned).toBe(false)
  })

  it('removes a deleted run and falls back the selection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    useRunHistoryStore.setState({
      runs: [run({ id: 'run-1' }), run({ id: 'run-2' })],
      selectedRunId: 'run-1',
      detail: run({ id: 'run-1' }),
    })

    await useRunHistoryStore.getState().deleteRun('run-1')

    const state = useRunHistoryStore.getState()
    expect(state.runs.map((item) => item.id)).toEqual(['run-2'])
    expect(state.selectedRunId).toBeNull()
    expect(state.detail).toBeNull()
  })

  it('propagates delete failures without mutating the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500)))
    useRunHistoryStore.setState({ runs: [run()] })

    await expect(useRunHistoryStore.getState().deleteRun('run-1')).rejects.toThrow('nope')
    expect(useRunHistoryStore.getState().runs).toHaveLength(1)
  })
})
