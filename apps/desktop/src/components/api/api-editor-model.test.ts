import { describe, expect, it } from 'vitest'
import type { ApiDefinition, RequestData } from '../../data/api-catalog'
import {
  buildRequestData,
  hasUnsavedChanges,
  modelFromApi,
  parseAuth,
  serializeAuth,
  validateModel,
} from './api-editor-model'

function backendApi(request: RequestData, overrides: Partial<ApiDefinition> = {}): ApiDefinition {
  return {
    id: 'request-1',
    collectionId: 'collection-1',
    collectionName: 'Saved APIs',
    name: 'Create item',
    method: request.method as ApiDefinition['method'],
    url: request.url,
    description: 'Creates an item.',
    source: 'backend',
    requestData: request,
    parameters: [],
    bindings: [],
    rules: [],
    history: [],
    ...overrides,
  }
}

const richRequest: RequestData = {
  method: 'POST',
  url: 'https://api.example.com/items',
  query_params: [
    { id: 'q1', name: 'dry_run', value: 'true', enabled: true },
    { id: 'q2', name: 'legacy', value: 'skip', enabled: false },
  ],
  headers: [
    { id: 'h1', name: 'Authorization', value: 'Bearer secret', enabled: true },
    { id: 'h2', name: 'X-Debug', value: 'on', enabled: false },
  ],
  body_type: 'json',
  body: '{"name":"demo"}',
  auth_config: { type: 'bearer', token: '{{token}}' },
}

describe('api editor model round-trip', () => {
  it('preserves disabled key-values, body type and auth through edit → build', () => {
    const model = modelFromApi(backendApi(richRequest))
    const rebuilt = buildRequestData(model)

    expect(rebuilt.query_params).toEqual(richRequest.query_params)
    expect(rebuilt.headers?.some((item) => item.name === 'X-Debug' && item.enabled === false)).toBe(true)
    expect(rebuilt.body_type).toBe('json')
    expect(rebuilt.body).toBe('{"name":"demo"}')
    expect(rebuilt.auth_config).toEqual({ type: 'bearer', token: '{{token}}' })
  })

  it('keeps unknown auth configs intact as raw JSON', () => {
    const custom = { type: 'oauth2', flow: 'client_credentials', scopes: ['a', 'b'] }
    const auth = parseAuth(custom)
    expect(auth.mode).toBe('raw')
    expect(serializeAuth(auth)).toEqual(custom)
  })

  it('preserves an explicitly stored empty auth config', () => {
    expect(serializeAuth(parseAuth({}))).toEqual({})
  })

  it('serializes basic and api_key auth losslessly', () => {
    expect(serializeAuth(parseAuth({ type: 'basic', username: 'u', password: 'p' })))
      .toEqual({ type: 'basic', username: 'u', password: 'p' })
    expect(serializeAuth(parseAuth({ type: 'api_key', key: 'X-Key', value: 'abc', in: 'query' })))
      .toEqual({ type: 'api_key', key: 'X-Key', value: 'abc', in: 'query' })
  })

  it('preserves extra fields and original key names in friendly auth modes', () => {
    const bearer = { type: 'bearer', token: 'abc', prefix: 'Token', metadata: { owner: 'api' } }
    expect(serializeAuth(parseAuth(bearer))).toEqual(bearer)

    const editedBearer = parseAuth(bearer)
    editedBearer.token = 'updated'
    expect(serializeAuth(editedBearer)).toEqual({ ...bearer, token: 'updated' })

    const apiKey = { type: 'api_key', name: 'X-Key', value: 'secret', in: 'query', rotate: true }
    expect(serializeAuth(parseAuth(apiKey))).toEqual(apiKey)

    const editedApiKey = parseAuth(apiKey)
    editedApiKey.apiKeyName = 'X-New-Key'
    expect(serializeAuth(editedApiKey)).toEqual({ ...apiKey, name: 'X-New-Key' })
  })

  it('preserves ids, blank disabled rows, and a body stored with body_type none', () => {
    const request: RequestData = {
      method: 'OPTIONS',
      url: 'https://api.example.com/items',
      query_params: [{ id: 'blank-1', name: '', value: '', enabled: false }],
      headers: [],
      body_type: 'none',
      body: 'opaque-body-that-must-not-be-dropped',
    }

    expect(buildRequestData(modelFromApi(backendApi(request, { method: 'OPTIONS' })))).toEqual(request)
  })

  it('does not treat a real description as a display-only placeholder', () => {
    const api = backendApi(richRequest, { description: 'Saved API request.' })
    const model = modelFromApi(api)

    expect(model.description).toBe('Saved API request.')
    expect(hasUnsavedChanges(model, api)).toBe(false)
  })

  it('rejects invalid raw auth JSON so saving is blocked', () => {
    const model = modelFromApi(backendApi(richRequest))
    model.auth = { ...model.auth, mode: 'raw', raw: '{ not json' }
    expect(validateModel(model)).toMatchObject({ field: 'auth' })
  })
})

describe('unsaved change detection', () => {
  it('reports a clean model as unchanged', () => {
    const api = backendApi(richRequest)
    expect(hasUnsavedChanges(modelFromApi(api), api)).toBe(false)
  })

  it('flags an edited field, a changed description, and a toggled row', () => {
    const api = backendApi(richRequest)

    const urlEdit = modelFromApi(api)
    urlEdit.url = 'https://api.example.com/items?v=2'
    expect(hasUnsavedChanges(urlEdit, api)).toBe(true)

    const descEdit = modelFromApi(api)
    descEdit.description = 'Updated description'
    expect(hasUnsavedChanges(descEdit, api)).toBe(true)

    const toggle = modelFromApi(api)
    toggle.headers = toggle.headers.map((item) => ({ ...item, enabled: !item.enabled }))
    expect(hasUnsavedChanges(toggle, api)).toBe(true)
  })
})

describe('validation', () => {
  it('requires a name and url', () => {
    const api = backendApi(richRequest)
    const model = modelFromApi(api)
    expect(validateModel({ ...model, name: '  ' })).toMatchObject({ field: 'name' })
    expect(validateModel({ ...model, url: '' })).toMatchObject({ field: 'url' })
    expect(validateModel(model)).toBeNull()
  })
})
