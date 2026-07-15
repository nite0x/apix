import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureCatalog } from '../data/api-catalog'
import { canRetryCatalog, useCatalogStore } from './catalog-store'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'false')
  useCatalogStore.setState({
    groups: [],
    loadState: 'idle',
    error: null,
    isPreview: false,
    revision: 0,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('catalog store refresh semantics', () => {
  it('transitions from loading to empty on the initial load', async () => {
    let resolveFetch!: (value: Response) => void
    const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingFetch))

    const refresh = useCatalogStore.getState().refresh()
    expect(useCatalogStore.getState().loadState).toBe('loading')

    resolveFetch(response([]))
    await refresh

    expect(useCatalogStore.getState()).toMatchObject({
      groups: [],
      loadState: 'empty',
      error: null,
      revision: 1,
    })
  })

  it('keeps the shared version visible while refreshing, then replaces it atomically', async () => {
    const existing = fixtureCatalog.slice(0, 1)
    useCatalogStore.setState({ groups: existing, loadState: 'ready', isPreview: true, revision: 7 })
    let resolveFetch!: (value: Response) => void
    const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingFetch))

    const refresh = useCatalogStore.getState().refresh()
    expect(useCatalogStore.getState()).toMatchObject({
      groups: existing,
      loadState: 'refreshing',
      revision: 7,
    })

    resolveFetch(response([]))
    await refresh

    expect(useCatalogStore.getState()).toMatchObject({
      groups: [],
      loadState: 'empty',
      isPreview: false,
      revision: 8,
    })
  })

  it('exposes a retryable offline error and recovers on retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response([]))
    vi.stubGlobal('fetch', fetchMock)

    await useCatalogStore.getState().refresh()
    expect(useCatalogStore.getState()).toMatchObject({
      groups: [],
      loadState: 'offline',
      error: 'Runtime unavailable',
    })
    expect(canRetryCatalog(useCatalogStore.getState().loadState)).toBe(true)

    await useCatalogStore.getState().refresh()
    expect(useCatalogStore.getState()).toMatchObject({ loadState: 'empty', error: null })
  })

  it('refreshes the single shared catalog after a successful mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([])))
    const mutation = vi.fn().mockResolvedValue('saved')

    await expect(useCatalogStore.getState().runMutation(mutation)).resolves.toBe('saved')

    expect(mutation).toHaveBeenCalledOnce()
    expect(useCatalogStore.getState()).toMatchObject({ loadState: 'empty', revision: 1 })
  })

  it('returns a committed mutation result even when the follow-up refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const mutation = vi.fn().mockResolvedValue('saved')

    await expect(useCatalogStore.getState().runMutation(mutation)).resolves.toBe('saved')

    expect(mutation).toHaveBeenCalledOnce()
    expect(useCatalogStore.getState()).toMatchObject({
      loadState: 'offline',
      error: 'Runtime unavailable',
    })
  })
})
