import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CatalogConflictError,
  CatalogError,
  archiveRequest,
  createRequest,
  discardWorkingCopy,
  getWorkingCopy,
  importCurl,
  saveWorkingCopy,
  updateWorkingCopy,
  type BackendWorkingCopy,
} from './api-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const draft: BackendWorkingCopy = {
  id: 'wc-1',
  project_id: 'default',
  owner_id: 'local',
  api_request_id: 'request-1',
  request: { method: 'GET', url: 'https://api.example.com/items' },
  source_type: 'manual',
  status: 'active',
  content_hash: 'hash',
  base_content_hash: 'hash',
  edit_version: 3,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request CRUD client', () => {
  it('creates a request with the full RequestData payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'new-1' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const created = await createRequest({
      collection_id: 'collection-1',
      name: 'Create item',
      description: 'desc',
      request: { method: 'POST', url: 'https://api.example.com/items', body_type: 'json', body: '{}' },
    })

    expect(created.id).toBe('new-1')
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      collection_id: 'collection-1',
      name: 'Create item',
      description: 'desc',
      request: { method: 'POST' },
    })
  })

  it('treats a 404 archive as success (already gone)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    await expect(archiveRequest('missing')).resolves.toBeUndefined()
  })

  it('surfaces archive failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)))
    await expect(archiveRequest('request-1')).rejects.toThrow('boom')
  })
})

describe('working copy edit semantics', () => {
  it('loads the latest Working Copy for conflict recovery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...draft, edit_version: 4 }))
    vi.stubGlobal('fetch', fetchMock)

    const copy = await getWorkingCopy('wc-1')

    expect(copy.edit_version).toBe(4)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/working-copies/wc-1')
  })

  it('raises a CatalogConflictError on a 409 instead of overwriting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'working copy changed or not found' }, 409)))

    await expect(updateWorkingCopy(draft, { method: 'GET', url: 'https://api.example.com/items?v=2' }))
      .rejects.toBeInstanceOf(CatalogConflictError)
  })

  it('sends the held edit_version and edited request on update', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...draft, edit_version: 4 }))
    vi.stubGlobal('fetch', fetchMock)

    const updated = await updateWorkingCopy(draft, { method: 'PUT', url: 'https://api.example.com/items' })

    expect(updated.edit_version).toBe(4)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      edit_version: 3,
      request: { method: 'PUT' },
    })
  })

  it('forwards collection, name and description to the save endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...draft, edit_version: 5 }))
    vi.stubGlobal('fetch', fetchMock)

    await saveWorkingCopy('wc-1', { collection_id: 'collection-1', name: 'Renamed', description: 'new desc' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/working-copies/wc-1/save')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      collection_id: 'collection-1',
      name: 'Renamed',
      description: 'new desc',
    })
  })

  it('raises a CatalogConflictError when saving a stale draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'saved request changed' }, 409)))

    await expect(saveWorkingCopy('wc-1', { name: 'Renamed' }))
      .rejects.toBeInstanceOf(CatalogConflictError)
  })

  it('ignores a 404 when discarding a draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    await expect(discardWorkingCopy('wc-1')).resolves.toBeUndefined()
  })
})

describe('cURL / raw HTTP import', () => {
  it('returns the parsed Working Copy draft without saving it', async () => {
    const imported = { ...draft, api_request_id: undefined, source_type: 'curl_import' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(imported, 201))
    vi.stubGlobal('fetch', fetchMock)

    const copy = await importCurl('curl https://api.example.com/items')

    expect(copy.source_type).toBe('curl_import')
    expect(copy.api_request_id).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/import/curl')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ content: 'curl https://api.example.com/items' })
  })

  it('surfaces the parser error message so the caller can recover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'expected a curl command' }, 400)))
    await expect(importCurl('nonsense')).rejects.toThrow('expected a curl command')
  })

  it('classifies a network failure as an offline CatalogError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(importCurl('curl https://api.example.com')).rejects.toBeInstanceOf(CatalogError)
  })
})
