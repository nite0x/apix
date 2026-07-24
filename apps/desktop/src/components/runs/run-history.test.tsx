// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendRun } from '../../services/api-client'
import { useRunHistoryStore } from '../../store/run-history-store'
import { RunHistory } from './run-history'

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
    response_body: { ok: true },
    response_truncated: false,
    is_pinned: false,
    started_at: '2026-07-24T10:00:00Z',
    duration_ms: 120,
    ...overrides,
  }
}

const runs: BackendRun[] = [
  run({ id: 'run-1', request_snapshot: { method: 'GET', url: 'https://api.example.com/users' } }),
  run({ id: 'run-2', status: 'failed', response_status: undefined, error_code: 'ECONNREFUSED', error_message: 'connection refused', request_snapshot: { method: 'POST', url: 'https://api.example.com/login' } }),
  run({ id: 'run-3', is_pinned: true, request_snapshot: { method: 'DELETE', url: 'https://api.example.com/users/9' } }),
]

/** Routes fetch by method/URL so the store client works against a stub. */
function stubFetch(options: { list?: BackendRun[]; listStatus?: number; listReject?: boolean } = {}) {
  const { list = runs, listStatus = 200, listReject = false } = options
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
    if (url.includes('/pin')) return Promise.resolve(new Response(null, { status: 204 }))
    if (/\/runs\/[^?]+$/.test(url)) {
      const id = url.split('/runs/')[1]
      return Promise.resolve(jsonResponse(list.find((item) => item.id === id) ?? list[0]))
    }
    // list
    if (listReject) return Promise.reject(new TypeError('Failed to fetch'))
    return Promise.resolve(listStatus === 200 ? jsonResponse(list) : jsonResponse({ error: 'boom' }, listStatus))
  }))
}

beforeEach(() => {
  useRunHistoryStore.setState({
    runs: [], selectedRunId: null, detail: null, listState: 'idle', detailState: 'idle', error: null, detailError: null, loaded: false,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('RunHistory states', () => {
  it('shows an empty state when there are no runs', async () => {
    stubFetch({ list: [] })
    render(<RunHistory onClose={vi.fn()} />)
    expect((await screen.findAllByText('还没有运行记录')).length).toBeGreaterThan(0)
  })

  it('shows an offline state with retry', async () => {
    stubFetch({ listReject: true })
    render(<RunHistory onClose={vi.fn()} />)
    expect(await screen.findByText(/Runtime 离线/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
  })

  it('shows an error state on a server failure', async () => {
    stubFetch({ listStatus: 500 })
    render(<RunHistory onClose={vi.fn()} />)
    expect(await screen.findByText('boom')).toBeTruthy()
  })
})

describe('RunHistory list and detail', () => {
  it('renders runs and opens a detail with request/response', async () => {
    const user = userEvent.setup()
    stubFetch()
    render(<RunHistory onClose={vi.fn()} />)

    await screen.findByText('https://api.example.com/users')
    await user.click(screen.getByText('https://api.example.com/users'))

    await waitFor(() => expect(useRunHistoryStore.getState().detailState).toBe('ready'))
    expect(screen.getByText('Response')).toBeTruthy()
    expect(screen.getByText(/HTTP 200/)).toBeTruthy()
  })

  it('filters by search text and by pinned-only', async () => {
    const user = userEvent.setup()
    stubFetch()
    render(<RunHistory onClose={vi.fn()} />)
    await screen.findByText('https://api.example.com/users')

    await user.type(screen.getByLabelText('搜索运行历史'), 'login')
    expect(screen.getByText('https://api.example.com/login')).toBeTruthy()
    expect(screen.queryByText('https://api.example.com/users')).toBeNull()

    await user.clear(screen.getByLabelText('搜索运行历史'))
    await user.click(screen.getByRole('button', { name: /仅看 pinned/ }))
    expect(screen.getByText('https://api.example.com/users/9')).toBeTruthy()
    expect(screen.queryByText('https://api.example.com/login')).toBeNull()
  })

  it('does not crash on a malformed / non-JSON response body', async () => {
    stubFetch({ list: [run({ id: 'run-x', response_body: 'not json <html>', request_snapshot: { method: 'GET', url: 'https://api.example.com/raw' } })] })
    render(<RunHistory onClose={vi.fn()} />)
    await screen.findByText('https://api.example.com/raw')
    // selecting shows the raw body without throwing
    await userEvent.setup().click(screen.getByText('https://api.example.com/raw'))
    await waitFor(() => expect(useRunHistoryStore.getState().detail?.id).toBe('run-x'))
    expect(screen.getByText('not json <html>')).toBeTruthy()
  })
})

describe('RunHistory pin and delete', () => {
  it('rolls back a pin when the runtime rejects it', async () => {
    const user = userEvent.setup()
    // list ok, but pin returns 404
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/pin')) return Promise.resolve(new Response(null, { status: 404 }))
      if (/\/runs\/[^?]+$/.test(url) && method === 'GET') return Promise.resolve(jsonResponse(run({ id: 'run-1' })))
      return Promise.resolve(jsonResponse([run({ id: 'run-1' })]))
    }))
    render(<RunHistory onClose={vi.fn()} />)
    await screen.findByText('https://api.example.com/users')
    await user.click(screen.getByText('https://api.example.com/users'))
    await waitFor(() => expect(useRunHistoryStore.getState().detail?.id).toBe('run-1'))

    await user.click(screen.getByRole('button', { name: '固定' }))
    await waitFor(() => expect(useRunHistoryStore.getState().runs[0].is_pinned).toBe(false))
  })

  it('confirms before deleting and removes the run', async () => {
    const user = userEvent.setup()
    stubFetch()
    render(<RunHistory onClose={vi.fn()} />)
    await screen.findByText('https://api.example.com/users')
    await user.click(screen.getByText('https://api.example.com/users'))
    await waitFor(() => expect(useRunHistoryStore.getState().detail?.id).toBe('run-1'))

    await user.click(screen.getByRole('button', { name: /删除/ }))
    const dialog = screen.getByRole('alertdialog', { name: '确认删除运行记录' })
    expect(useRunHistoryStore.getState().runs).toHaveLength(3)

    await user.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(useRunHistoryStore.getState().runs.find((r) => r.id === 'run-1')).toBeUndefined())
  })
})
