import {
  fixtureCatalog,
  type ApiCollectionGroup,
  type ApiDefinition,
  type ApiMethod,
  type RequestData,
  type RequestKeyValue,
} from '../data/api-catalog'

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

export type BackendKeyValue = RequestKeyValue
export type BackendRequestData = RequestData

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

export interface BackendWorkingCopy {
  id: string
  project_id: string
  owner_id: string
  api_request_id?: string | null
  environment_id?: string | null
  name?: string
  request: BackendRequestData
  source_type: string
  status: string
  content_hash: string
  base_content_hash?: string | null
  edit_version: number
  created_at?: string
  updated_at?: string
  expires_at?: string | null
  discarded_at?: string | null
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

/**
 * Raised when a Working Copy edit is rejected because the server-side
 * edit_version moved on. Never resolved silently: the caller must offer a
 * reload-or-keep recovery path so a newer version is not overwritten.
 */
export class CatalogConflictError extends Error {
  constructor(message = 'This request was modified elsewhere') {
    super(message)
    this.name = 'CatalogConflictError'
  }
}

async function json<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
  return data
}

function methodOf(value: string): ApiMethod {
  const upper = value.toUpperCase()
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE' || upper === 'HEAD' || upper === 'OPTIONS'
    ? upper
    : 'GET'
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
    description: request.description ?? '',
    source: 'backend',
    requestData: request.request,
    parameters,
    bindings: [],
    rules: [],
    history: [],
  }
}

export interface RequestInput {
  collection_id: string
  name: string
  description?: string
  request: RequestData
}

/** Creates a durable API Request directly in a collection. */
export async function createRequest(input: RequestInput): Promise<BackendRequest> {
  return fetch(`${API_BASE}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<BackendRequest>)
}

export async function getRequest(id: string): Promise<BackendRequest> {
  return fetch(`${API_BASE}/requests/${encodeURIComponent(id)}`).then(json<BackendRequest>)
}

/** Archives a saved API Request. Removes it from every catalog consumer. */
export async function archiveRequest(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/requests/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `Archive failed (${response.status})`)
  }
}

/**
 * Opens a Working Copy bound to a saved request. The runtime seeds the draft
 * with the request's current RequestData and name, so edits stay lossless.
 */
export async function createWorkingCopyForRequest(apiRequestId: string): Promise<BackendWorkingCopy> {
  return fetch(`${API_BASE}/working-copies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_request_id: apiRequestId, source_type: 'manual' }),
  }).then(json<BackendWorkingCopy>)
}

/** Reloads the latest server version of an existing Working Copy. */
export async function getWorkingCopy(id: string): Promise<BackendWorkingCopy> {
  return fetch(`${API_BASE}/working-copies/${encodeURIComponent(id)}`).then(json<BackendWorkingCopy>)
}

/**
 * Persists the edited RequestData onto a Working Copy using optimistic
 * concurrency. A 409 becomes a CatalogConflictError so newer versions are
 * never silently clobbered.
 */
export async function updateWorkingCopy(copy: BackendWorkingCopy, request: RequestData): Promise<BackendWorkingCopy> {
  const response = await fetch(`${API_BASE}/working-copies/${encodeURIComponent(copy.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...copy, request, edit_version: copy.edit_version }),
  })
  if (response.status === 409) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new CatalogConflictError(data.error)
  }
  return json<BackendWorkingCopy>(response)
}

export interface SaveWorkingCopyInput {
  collection_id?: string
  name: string
  description?: string
}

/** Promotes a Working Copy draft into its durable API Request. */
export async function saveWorkingCopy(id: string, input: SaveWorkingCopyInput): Promise<BackendWorkingCopy> {
  const response = await fetch(`${API_BASE}/working-copies/${encodeURIComponent(id)}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (response.status === 409) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new CatalogConflictError(data.error)
  }
  return json<BackendWorkingCopy>(response)
}

/** Discards an editing draft. Safe to call after a successful save. */
export async function discardWorkingCopy(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/working-copies/${encodeURIComponent(id)}/discard`, { method: 'POST' })
  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `Discard failed (${response.status})`)
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

/**
 * Parses pasted cURL / raw HTTP into a Working Copy draft. Import does NOT save:
 * the returned draft must be reviewed and explicitly saved to become a durable API.
 * A network failure raises a CatalogError('offline'); an invalid request raises a
 * CatalogError('error') carrying the parser message so the caller can recover.
 */
export async function importCurl(content: string): Promise<BackendWorkingCopy> {
  try {
    return await fetch(`${API_BASE}/import/curl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then(json<BackendWorkingCopy>)
  } catch (error) {
    throw classifyFetchError(error)
  }
}
