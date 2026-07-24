import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CatalogError,
  archiveCollection,
  checkRuntimeHealth,
  createCollection,
  deleteRun,
  getRules,
  listRuns,
  setRunPinned,
  updateCollection,
  updateRules,
  type RuntimeRule,
} from './api-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('collection client', () => {
  it('creates a collection with a POST and name payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'c-1', name: 'Auth' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const created = await createCollection({ name: 'Auth', description: 'desc' })

    expect(created.id).toBe('c-1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/collections')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Auth', description: 'desc' })
  })

  it('renames a collection with a PATCH to the id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'c-1', name: 'Renamed' }))
    vi.stubGlobal('fetch', fetchMock)

    await updateCollection('c-1', { name: 'Renamed' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/collections/c-1')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Renamed' })
  })

  it('treats a 204 archive as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(archiveCollection('c-1')).resolves.toBeUndefined()
  })

  it('treats a 404 archive as success (already gone)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    await expect(archiveCollection('missing')).resolves.toBeUndefined()
  })

  it('surfaces other archive failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)))
    await expect(archiveCollection('c-1')).rejects.toThrow('boom')
  })
})

describe('rules client', () => {
  const rules: RuntimeRule[] = [
    { id: 'r-1', name: 'Pause DELETE', enabled: true, trigger: 'before', match: { method: 'DELETE' }, action: 'pause' },
  ]

  it('maps GET /rules into an array (null becomes empty)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getRules()).resolves.toEqual([])
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rules')
  })

  it('PUTs the complete rules array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await updateRules(rules)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/rules')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(rules)
  })

  it('classifies a network failure as offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(getRules()).rejects.toBeInstanceOf(CatalogError)
  })
})

describe('run history client', () => {
  it('lists runs with project_id and limit query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 'run-1' }]))
    vi.stubGlobal('fetch', fetchMock)

    const runs = await listRuns({ limit: 25 })

    expect(runs).toHaveLength(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/runs?')
    expect(url).toContain('project_id=default')
    expect(url).toContain('limit=25')
  })

  it('pins a run via POST with the pinned body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await setRunPinned('run-1', true)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/runs/run-1/pin')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ pinned: true })
  })

  it('surfaces a 404 when pinning (so optimistic state can roll back)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    await expect(setRunPinned('missing', true)).rejects.toThrow()
  })

  it('deletes a run and treats 204 and 404 as success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteRun('run-1')).resolves.toBeUndefined()
    await expect(deleteRun('gone')).resolves.toBeUndefined()
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE')
  })

  it('surfaces other delete failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500)))
    await expect(deleteRun('run-1')).rejects.toThrow('nope')
  })
})

describe('runtime health', () => {
  it('returns true on a 2xx health response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    await expect(checkRuntimeHealth()).resolves.toBe(true)
  })

  it('returns false when the runtime is offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(checkRuntimeHealth()).resolves.toBe(false)
  })

  it('returns false on a non-2xx health response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(checkRuntimeHealth()).resolves.toBe(false)
  })
})
