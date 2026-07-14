import { fixtureCatalog, type ApiCollectionGroup, type ApiDefinition, type ApiMethod } from '../data/api-catalog'

export const API_BASE = 'http://127.0.0.1:4317/api'

/** Opt-in only. Default production/dev path never merges fixtures into catalog. */
export function useFixtureCatalog(): boolean {
  return import.meta.env.VITE_USE_FIXTURE_CATALOG === 'true'
}

export interface BackendCollection {
  id: string
  project_id: string
  parent_id?: string | null
  name: string
  description?: string
  sort_order: number
  status: string
  created_by?: string
  created_at: string
  updated_at: string
  archived_at?: string | null
}

export interface BackendKeyValue {
  id?: string
  name: string
  value: string
  enabled: boolean
}

export interface BackendRequestData {
  method: string
  url: string
  query_params?: BackendKeyValue[]
  headers?: BackendKeyValue[]
  body_type?: string
  body?: string
  auth_config?: Record<string, unknown>
}

export interface BackendRequest {
  id: string
  collection_id: string
  name: string
  description?: string
  request: BackendRequestData
  source_type?: string
  status?: string
  sort_order?: number
  created_by?: string
  updated_by?: string
  created_at?: string
  updated_at?: string
  archived_at?: string | null
}

export interface TryResult {
  status: number
  durationMs: number
  size: string
  body: unknown
  demo: boolean
}

export type CatalogFailureKind = 'offline' | 'error'

export class CatalogError extends Error {
  readonly kind: CatalogFailureKind

  constructor(kind: CatalogFailureKind, message: string) {
    super(message)
    this.name = 'CatalogError'
    this.kind = kind
  }
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

function collectionIcon(index: number): ApiCollectionGroup['icon'] {
  if (index % 3 === 0) return 'lock'
  if (index % 3 === 1) return 'users'
  return 'file'
}

export function toDefinition(collection: Pick<BackendCollection, 'id' | 'name'>, request: BackendRequest): ApiDefinition {
  const parameters = [
    ...(request.request.query_params ?? []).filter((item) => item.enabled).map((item) => ({
      name: item.name, location: 'query' as const, type: 'string', defaultValue: item.value,
    })),
    ...(request.request.headers ?? []).filter((item) => item.enabled).map((item) => ({
      name: item.name,
      location: 'header' as const,
      type: 'string',
      defaultValue: item.name.toLowerCase() === 'authorization' ? '••••••••' : item.value,
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

function classifyFetchError(error: unknown): CatalogError {
  if (error instanceof CatalogError) return error
  const message = error instanceof Error ? error.message : 'Failed to load catalog'
  const offline = error instanceof TypeError
    || /failed to fetch|networkerror|load failed/i.test(message)
  return new CatalogError(offline ? 'offline' : 'error', offline ? 'Runtime unavailable' : message)
}

/**
 * Loads the durable catalog from the local runtime.
 * Never silently merges fixture data. Set VITE_USE_FIXTURE_CATALOG=true to opt in.
 */
export async function loadCatalog(): Promise<ApiCollectionGroup[]> {
  if (useFixtureCatalog()) {
    return fixtureCatalog
  }

  try {
    const collections = await fetch(`${API_BASE}/collections`).then(json<BackendCollection[]>)
    const groups = await Promise.all(collections.map(async (collection, index) => {
      const requests = await fetch(
        `${API_BASE}/requests?collection_id=${encodeURIComponent(collection.id)}`,
      ).then(json<BackendRequest[]>)
      return {
        id: collection.id,
        name: collection.name,
        icon: collectionIcon(index),
        apis: requests.map((request) => toDefinition(collection, request)),
      }
    }))
    return groups
  } catch (error) {
    throw classifyFetchError(error)
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
