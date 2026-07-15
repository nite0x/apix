import type { ApiDefinition, ApiMethod, RequestData, RequestKeyValue } from '../../data/api-catalog'

export const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
export const BODY_TYPES = ['none', 'json', 'text', 'form', 'multipart', 'binary'] as const

export type AuthMode = 'none' | 'bearer' | 'basic' | 'api_key' | 'raw'

export interface AuthState {
  mode: AuthMode
  token: string
  username: string
  password: string
  apiKeyName: string
  apiKeyValue: string
  apiKeyIn: 'header' | 'query'
  raw: string
  /** Original config used to preserve fields the friendly editor does not expose. */
  original?: Record<string, unknown>
}

export interface EditorModel {
  name: string
  description: string
  method: ApiMethod
  url: string
  queryParams: RequestKeyValue[]
  headers: RequestKeyValue[]
  bodyType: string
  body: string
  auth: AuthState
}

export function blankKeyValue(): RequestKeyValue {
  return { name: '', value: '', enabled: true }
}

function emptyAuth(): AuthState {
  return { mode: 'none', token: '', username: '', password: '', apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header', raw: '' }
}

/**
 * Splits a stored auth_config into friendly fields for the common schemes and
 * keeps everything else as raw JSON, so no configuration is dropped on edit.
 */
export function parseAuth(config?: Record<string, unknown>): AuthState {
  const auth = emptyAuth()
  if (!config) return auth
  if (Object.keys(config).length === 0) return { ...auth, original: config }
  const type = typeof config.type === 'string' ? config.type : ''
  if (type === 'bearer') {
    return { ...auth, mode: 'bearer', token: String(config.token ?? ''), original: config }
  }
  if (type === 'basic') {
    return {
      ...auth,
      mode: 'basic',
      username: String(config.username ?? ''),
      password: String(config.password ?? ''),
      original: config,
    }
  }
  if (type === 'api_key') {
    return {
      ...auth,
      mode: 'api_key',
      apiKeyName: String(config.key ?? config.name ?? ''),
      apiKeyValue: String(config.value ?? ''),
      apiKeyIn: config.in === 'query' ? 'query' : 'header',
      original: config,
    }
  }
  return { ...auth, mode: 'raw', raw: JSON.stringify(config, null, 2) }
}

/** Rebuilds an auth_config record. Throws on invalid raw JSON so save is blocked. */
export function serializeAuth(auth: AuthState): Record<string, unknown> | undefined {
  switch (auth.mode) {
    case 'none':
      return auth.original && Object.keys(auth.original).length === 0 ? { ...auth.original } : undefined
    case 'bearer':
      if (auth.original?.type === 'bearer') {
        const originalToken = String(auth.original.token ?? '')
        return auth.token === originalToken
          ? { ...auth.original }
          : { ...auth.original, token: auth.token }
      }
      return { type: 'bearer', token: auth.token }
    case 'basic': {
      if (auth.original?.type === 'basic') {
        const result = { ...auth.original }
        if (auth.username !== String(auth.original.username ?? '')) result.username = auth.username
        if (auth.password !== String(auth.original.password ?? '')) result.password = auth.password
        return result
      }
      return { type: 'basic', username: auth.username, password: auth.password }
    }
    case 'api_key': {
      if (auth.original?.type === 'api_key') {
        const result = { ...auth.original }
        const originalName = String(auth.original.key ?? auth.original.name ?? '')
        if (auth.apiKeyName !== originalName) {
          if (Object.hasOwn(auth.original, 'key') || !Object.hasOwn(auth.original, 'name')) result.key = auth.apiKeyName
          else result.name = auth.apiKeyName
        }
        if (auth.apiKeyValue !== String(auth.original.value ?? '')) result.value = auth.apiKeyValue
        const originalIn = auth.original.in === 'query' ? 'query' : 'header'
        if (auth.apiKeyIn !== originalIn) result.in = auth.apiKeyIn
        return result
      }
      return { type: 'api_key', key: auth.apiKeyName, value: auth.apiKeyValue, in: auth.apiKeyIn }
    }
    case 'raw': {
      const text = auth.raw.trim()
      if (!text) return undefined
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError('Auth config must be a JSON object')
      }
      return parsed as Record<string, unknown>
    }
  }
}

function normalizeKeyValues(items: RequestKeyValue[]): RequestKeyValue[] {
  return items.map((item) => ({ ...item }))
}

/** Builds a durable RequestData payload, preserving disabled rows and auth. */
export function buildRequestData(model: EditorModel): RequestData {
  const request: RequestData = {
    method: model.method,
    url: model.url.trim(),
    query_params: normalizeKeyValues(model.queryParams),
    headers: normalizeKeyValues(model.headers),
    body_type: model.bodyType,
    body: model.body,
  }
  const auth = serializeAuth(model.auth)
  if (auth) request.auth_config = auth
  return request
}

export function emptyModel(): EditorModel {
  return {
    name: '',
    description: '',
    method: 'GET',
    url: '',
    queryParams: [],
    headers: [],
    bodyType: 'none',
    body: '',
    auth: emptyAuth(),
  }
}

/** Seeds the editor from a saved API without dropping any RequestData field. */
export function modelFromApi(api: ApiDefinition): EditorModel {
  const request = api.requestData
  return {
    name: api.name,
    description: api.description,
    method: (request?.method?.toUpperCase() as ApiMethod) ?? api.method,
    url: request?.url ?? api.url,
    queryParams: (request?.query_params ?? []).map((item) => ({ ...item })),
    headers: (request?.headers ?? []).map((item) => ({ ...item })),
    bodyType: request?.body_type ?? 'none',
    body: request?.body ?? '',
    auth: parseAuth(request?.auth_config),
  }
}

/** Seeds the editor from a raw backend request payload (used for conflict reload). */
export function modelFromBackendRequest(fields: {
  name: string
  description?: string
  request: RequestData
}): EditorModel {
  return {
    name: fields.name,
    description: fields.description ?? '',
    method: (fields.request.method?.toUpperCase() as ApiMethod) ?? 'GET',
    url: fields.request.url ?? '',
    queryParams: (fields.request.query_params ?? []).map((item) => ({ ...item })),
    headers: (fields.request.headers ?? []).map((item) => ({ ...item })),
    bodyType: fields.request.body_type ?? 'none',
    body: fields.request.body ?? '',
    auth: parseAuth(fields.request.auth_config),
  }
}

function canonicalRequest(request: RequestData): string {
  const canonicalKeyValues = (items: RequestKeyValue[] = []) => items
    .map((item) => ({ ...item }))
  const auth = request.auth_config && Object.keys(request.auth_config).length > 0 ? request.auth_config : null
  return JSON.stringify({
    method: (request.method || 'GET').toUpperCase(),
    url: (request.url || '').trim(),
    query_params: canonicalKeyValues(request.query_params),
    headers: canonicalKeyValues(request.headers),
    body_type: request.body_type || (request.body ? 'json' : 'none'),
    body: request.body || '',
    auth_config: auth,
  })
}

/** True when the editor differs from the saved API (drives the unsaved badge). */
export function hasUnsavedChanges(model: EditorModel, api: ApiDefinition): boolean {
  if (model.name !== api.name) return true
  if (model.description !== api.description) return true
  try {
    const original = api.requestData ?? { method: api.method, url: api.url }
    return canonicalRequest(buildRequestData(model)) !== canonicalRequest(original)
  } catch {
    return true
  }
}

export interface ModelValidationError {
  field: 'name' | 'url' | 'auth'
  message: string
}

/** Validates required fields and auth JSON before a save is attempted. */
export function validateModel(model: EditorModel): ModelValidationError | null {
  if (!model.name.trim()) return { field: 'name', message: 'Name is required' }
  if (!model.url.trim()) return { field: 'url', message: 'URL is required' }
  try {
    serializeAuth(model.auth)
  } catch (error) {
    return { field: 'auth', message: error instanceof Error ? error.message : 'Invalid auth config' }
  }
  return null
}
