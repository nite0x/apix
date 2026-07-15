import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureCatalog } from '../data/api-catalog'
import { CatalogError, loadCatalog, type BackendCollection, type BackendRequest } from './api-client'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const collection: BackendCollection = {
  id: 'collection-1',
  project_id: 'project-1',
  name: 'Saved APIs',
  sort_order: 0,
  status: 'active',
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
}

const savedRequest: BackendRequest = {
  id: 'request-1',
  collection_id: collection.id,
  name: 'Create item',
  description: 'Creates an item.',
  request: {
    method: 'POST',
    url: 'https://api.example.com/items',
    query_params: [{ id: 'query-1', name: 'dry_run', value: 'true', enabled: true }],
    headers: [{ id: 'header-1', name: 'Authorization', value: 'Bearer secret', enabled: true }],
    body_type: 'json',
    body: '{"name":"demo"}',
    auth_config: { type: 'bearer', token: '{{token}}' },
  },
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('loadCatalog', () => {
  it('loads only Runtime collections and preserves the complete request payload', async () => {
    vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'false')
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      return Promise.resolve(response(url.includes('/requests?') ? [savedRequest] : [collection]))
    })
    vi.stubGlobal('fetch', fetchMock)

    const groups = await loadCatalog()

    expect(groups).toHaveLength(1)
    expect(groups[0]?.apis).toHaveLength(1)
    expect(groups[0]?.apis[0]).toMatchObject({
      id: savedRequest.id,
      source: 'backend',
      method: 'POST',
      url: savedRequest.request.url,
      requestData: savedRequest.request,
    })
    expect(groups.flatMap((group) => group.apis).every((api) => api.source === 'backend')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves HEAD and OPTIONS methods and does not invent a stored description', async () => {
    vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'false')
    const optionsRequest = {
      ...savedRequest,
      description: undefined,
      request: { ...savedRequest.request, method: 'OPTIONS' },
    }
    const fetchMock = vi.fn((input: string | URL | Request) => Promise.resolve(
      response(String(input).includes('/requests?') ? [optionsRequest] : [collection]),
    ))
    vi.stubGlobal('fetch', fetchMock)

    const groups = await loadCatalog()

    expect(groups[0]?.apis[0]).toMatchObject({ method: 'OPTIONS', description: '' })
  })

  it('returns an empty catalog for an empty Runtime database', async () => {
    vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'false')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([])))

    await expect(loadCatalog()).resolves.toEqual([])
  })

  it('classifies an unavailable Runtime without falling back to fixtures', async () => {
    vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'false')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(loadCatalog()).rejects.toMatchObject({
      kind: 'offline',
      message: 'Runtime unavailable',
    } satisfies Partial<CatalogError>)
  })

  it('surfaces Runtime response errors without falling back to fixtures', async () => {
    vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'false')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'database unavailable' }, 503)))

    await expect(loadCatalog()).rejects.toMatchObject({
      kind: 'error',
      message: 'database unavailable',
    } satisfies Partial<CatalogError>)
  })

  it('uses fixtures only after explicit opt-in', async () => {
    vi.stubEnv('VITE_USE_FIXTURE_CATALOG', 'true')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadCatalog()).resolves.toBe(fixtureCatalog)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fixtureCatalog.flatMap((group) => group.apis).every((api) => api.source === 'fixture')).toBe(true)
  })
})
