import { fixtureCatalog, type ApiCollectionGroup, type ApiDefinition, type ApiMethod } from '../data/api-catalog'

const API_BASE = 'http://127.0.0.1:4317/api'

interface BackendCollection {
  id: string
  name: string
}

interface BackendKeyValue {
  name: string
  value: string
  enabled: boolean
}

interface BackendRequest {
  id: string
  collection_id: string
  name: string
  description?: string
  request: {
    method: string
    url: string
    query_params?: BackendKeyValue[]
    headers?: BackendKeyValue[]
  }
}

export interface TryResult {
  status: number
  durationMs: number
  size: string
  body: unknown
  demo: boolean
}

async function json<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
  return data
}

function methodOf(value: string): ApiMethod {
  const upper = value.toUpperCase()
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE' ? upper : 'GET'
}

function toDefinition(collection: BackendCollection, request: BackendRequest): ApiDefinition {
  const parameters = [
    ...(request.request.query_params ?? []).filter((item) => item.enabled).map((item) => ({
      name: item.name, location: 'query' as const, type: 'string', defaultValue: item.value,
    })),
    ...(request.request.headers ?? []).filter((item) => item.enabled).map((item) => ({
      name: item.name, location: 'header' as const, type: 'string', defaultValue: item.name.toLowerCase() === 'authorization' ? '••••••••' : item.value,
    })),
  ]
  return {
    id: request.id,
    collectionId: collection.id,
    collectionName: collection.name,
    name: request.name,
    method: methodOf(request.request.method),
    url: request.request.url,
    description: request.description ?? 'Saved API request.',
    source: 'backend',
    parameters,
    bindings: [],
    rules: [],
    history: [],
  }
}

export async function loadCatalog(): Promise<ApiCollectionGroup[]> {
  try {
    const collections = await fetch(`${API_BASE}/collections`).then(json<BackendCollection[]>)
    if (collections.length === 0) return fixtureCatalog
    const groups = await Promise.all(collections.map(async (collection, index) => {
      const requests = await fetch(`${API_BASE}/requests?collection_id=${encodeURIComponent(collection.id)}`).then(json<BackendRequest[]>)
      return {
        id: collection.id,
        name: collection.name,
        icon: (index % 3 === 0 ? 'lock' : index % 3 === 1 ? 'users' : 'file') as ApiCollectionGroup['icon'],
        apis: requests.map((request) => toDefinition(collection, request)),
      }
    }))
    if (!groups.some((group) => group.apis.length > 0)) return fixtureCatalog

    // Keep real saved requests visible while retaining the richer Phase 4 sample
    // catalog. This lets the UI stay useful before every backend collection has
    // been populated, and fixture requests remain clearly marked as previews.
    return fixtureCatalog.map((fixtureGroup) => {
      const backendGroup = groups.find((group) => group.id === fixtureGroup.id)
      if (!backendGroup) return fixtureGroup
      const fixtureApis = fixtureGroup.apis.filter(
        (fixtureApi) => !backendGroup.apis.some((backendApi) => backendApi.id === fixtureApi.id),
      )
      return { ...fixtureGroup, apis: [...backendGroup.apis, ...fixtureApis] }
    }).concat(groups.filter((group) => !fixtureCatalog.some((fixtureGroup) => fixtureGroup.id === group.id)))
  } catch {
    return fixtureCatalog
  }
}

export async function tryApi(api: ApiDefinition): Promise<TryResult> {
  if (api.source === 'backend') {
    const startedAt = Date.now()
    const result = await fetch(`${API_BASE}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_request_id: api.id }),
    }).then(json<Record<string, unknown>>)
    const body = result.response_body
    return {
      status: Number(result.response_status ?? 0),
      durationMs: Number(result.duration_ms ?? Date.now() - startedAt),
      size: result.response_size ? `${result.response_size}B` : '—',
      body,
      demo: false,
    }
  }

  await new Promise((resolve) => window.setTimeout(resolve, 450))
  return {
    status: api.method === 'POST' ? 201 : 200,
    durationMs: 241,
    size: '342B',
    body: api.id === 'user-detail'
      ? { id: 42, name: 'Alice Chen', role: 'admin' }
      : api.id === 'list-users'
        ? { items: [{ id: 42, name: 'Alice Chen', role: 'admin' }], total: 1 }
        : { ok: true, preview: true },
    demo: true,
  }
}

export async function resumeStep(stepId: string, action: 'continue' | 'skip' | 'stop', modifiedInput?: unknown): Promise<void> {
  await fetch(`${API_BASE}/steps/${encodeURIComponent(stepId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, modified_input: modifiedInput }),
  }).then(json)
}

export async function importCurl(content: string): Promise<void> {
  await fetch(`${API_BASE}/import/curl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then(json)
}
