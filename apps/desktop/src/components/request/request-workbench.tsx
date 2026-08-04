import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import {
  IconBraces,
  IconCode,
  IconDeviceFloppy,
  IconExternalLink,
  IconLoader,
  IconPlus,
  IconRefresh,
  IconSend,
  IconTrash,
} from '@tabler/icons-react'
import type { RequestData, RequestKeyValue } from '../../data/api-catalog'
import {
  CatalogConflictError,
  CatalogNotFoundError,
  createCollection,
  createWorkingCopy,
  createWorkingCopyForRequest,
  getWorkingCopy,
  importCurl,
  listCollections,
  runWorkingCopy,
  saveWorkingCopy,
  updateWorkingCopy,
  type BackendRun,
  type BackendWorkingCopy,
} from '../../services/api-client'
import { useCatalogStore } from '../../store/catalog-store'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const BODY_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'urlencoded', label: 'URL Encoded' },
  { value: 'raw', label: 'Raw Text' },
] as const

type RequestTab = 'params' | 'headers' | 'body'
type EditorMode = 'form' | 'raw'

function apiName(request: RequestData): string {
  const value = request.url.trim()
  if (!value) return 'New request'
  try {
    return new URL(value).pathname || '/'
  } catch {
    return value
      .replace(/^\{\{[^}]+}}/, '')
      .replace(/^https?:\/\/[^/]+/i, '')
      .split('?')[0] || value
  }
}

function headersText(request: RequestData): string {
  return (request.headers ?? [])
    .filter((item) => item.enabled)
    .map(({ name, value }) => `${name}: ${value}`)
    .join('\n')
}

function parseHeaders(value: string): RequestData['headers'] {
  return value.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(':')
    if (separator <= 0) return []
    return [{
      name: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
      enabled: true,
    }]
  })
}

function splitURL(value: string): { url: string; queryParams: RequestKeyValue[] } {
  const hashIndex = value.indexOf('#')
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value
  const queryIndex = withoutHash.indexOf('?')
  if (queryIndex < 0) return { url: value, queryParams: [] }
  const query = withoutHash.slice(queryIndex + 1)
  return {
    url: `${withoutHash.slice(0, queryIndex)}${hash}`,
    queryParams: Array.from(new URLSearchParams(query).entries()).map(([name, itemValue]) => ({
      name,
      value: itemValue,
      enabled: true,
    })),
  }
}

function queryRows(request: RequestData): RequestKeyValue[] {
  return [...splitURL(request.url).queryParams, ...(request.query_params ?? [])]
}

function queryText(rows: RequestKeyValue[]): string {
  const params = new URLSearchParams()
  rows.forEach((item) => {
    if (item.enabled && item.name) params.append(item.name, item.value)
  })
  return params.toString()
}

function displayURL(request: RequestData): string {
  const parsed = splitURL(request.url)
  const query = queryText([...parsed.queryParams, ...(request.query_params ?? [])])
  if (!query) return parsed.url
  const hashIndex = parsed.url.indexOf('#')
  if (hashIndex < 0) return `${parsed.url}?${query}`
  return `${parsed.url.slice(0, hashIndex)}?${query}${parsed.url.slice(hashIndex)}`
}

function parseQueryText(value: string): RequestKeyValue[] {
  return Array.from(new URLSearchParams(value.replace(/^\?/, '')).entries()).map(([name, itemValue]) => ({
    name,
    value: itemValue,
    enabled: true,
  }))
}

function bodyType(value?: string): string {
  if (!value || value === 'none') return 'none'
  if (value === 'json') return 'json'
  if (value === 'form' || value === 'x-www-form-urlencoded' || value === 'urlencoded') return 'urlencoded'
  return 'raw'
}

interface KeyValueRowsProps {
  label: string
  rows: RequestKeyValue[]
  disabled?: boolean
  emptyLabel: string
  onChange: (rows: RequestKeyValue[]) => void
}

function KeyValueRows({ label, rows, disabled = false, emptyLabel, onChange }: KeyValueRowsProps) {
  function patchRow(index: number, patch: Partial<RequestKeyValue>) {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
  }

  return (
    <div className="mr-kv-editor">
      <div className="mr-kv-head" aria-hidden="true">
        <span />
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {rows.length === 0 && <div className="mr-kv-empty">{emptyLabel}</div>}
      {rows.map((row, index) => (
        <div className="mr-kv-row" key={row.id ?? `${label}-${index}`}>
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(event) => patchRow(index, { enabled: event.target.checked })}
            disabled={disabled}
            aria-label={`启用${label} ${index + 1}`}
          />
          <input
            value={row.name}
            onChange={(event) => patchRow(index, { name: event.target.value })}
            disabled={disabled}
            placeholder={label === 'Header' ? 'Header name' : 'Parameter'}
            aria-label={`${label} key ${index + 1}`}
          />
          <input
            value={row.value}
            onChange={(event) => patchRow(index, { value: event.target.value })}
            disabled={disabled}
            placeholder="Value"
            aria-label={`${label} value ${index + 1}`}
          />
          <button
            type="button"
            className="mr-kv-delete"
            onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
            disabled={disabled}
            aria-label={`删除${label} ${index + 1}`}
          >
            <IconTrash size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="mr-add-row"
        onClick={() => onChange([...rows, {
          name: '',
          value: '',
          enabled: true,
        }])}
        disabled={disabled}
      >
        <IconPlus size={12} /> 添加{label === 'Header' ? ' Header' : '参数'}
      </button>
    </div>
  )
}

function responseBody(run: BackendRun): string {
  if (run.error_message) return run.error_message
  if (typeof run.response_body === 'string') return run.response_body
  return JSON.stringify(run.response_body ?? null, null, 2)
}

export interface RequestWorkbenchProps {
  request: RequestData
  sourceApiRequestId?: string | null
  onChange: (request: RequestData) => void
  onSourceApiRequestIdChange?: (requestId: string | null) => void
  onRunResult?: (run: BackendRun) => void
  initialRun?: BackendRun | null
  onOpenAPI?: () => void
  compact?: boolean
  hasSent?: boolean
  autosaveWorkingCopy?: boolean
}

type SaveState = 'unsaved' | 'modified' | 'saving' | 'saved' | 'error' | 'conflict'

export function RequestWorkbench({
  request,
  sourceApiRequestId,
  onChange,
  onSourceApiRequestIdChange,
  onRunResult,
  initialRun = null,
  onOpenAPI,
  compact = false,
  hasSent = false,
  autosaveWorkingCopy = true,
}: RequestWorkbenchProps) {
  const requestRef = useRef(request)
  const sourceRef = useRef(sourceApiRequestId)
  const workingCopyRef = useRef<BackendWorkingCopy | null>(null)
  const creatingRef = useRef<Promise<BackendWorkingCopy> | null>(null)
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve())
  const editedRef = useRef(false)
  const [workingCopy, setWorkingCopy] = useState<BackendWorkingCopy | null>(null)
  const [saveState, setSaveState] = useState<SaveState>(sourceApiRequestId ? 'saved' : 'unsaved')
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [run, setRun] = useState<BackendRun | null>(initialRun)
  const [headerDraft, setHeaderDraft] = useState(() => headersText(request))
  const [urlDraft, setURLDraft] = useState(() => displayURL(request))
  const [queryDraft, setQueryDraft] = useState(() => queryText(queryRows(request)))
  const [activeTab, setActiveTab] = useState<RequestTab>(() =>
    request.body || bodyType(request.body_type) !== 'none'
      ? 'body'
      : queryRows(request).length > 0
        ? 'params'
        : (request.headers ?? []).length > 0
          ? 'headers'
          : 'params',
  )
  const [paramsMode, setParamsMode] = useState<EditorMode>('form')
  const [headersMode, setHeadersMode] = useState<EditorMode>('form')
  const [responseTab, setResponseTab] = useState<'body' | 'headers'>('body')
  const [bodyFormRows, setBodyFormRows] = useState<RequestKeyValue[]>(() =>
    bodyType(request.body_type) === 'urlencoded' ? parseQueryText(request.body ?? '') : [],
  )

  useEffect(() => {
    requestRef.current = request
  }, [request])

  useEffect(() => {
    if (sourceRef.current === sourceApiRequestId) return
    sourceRef.current = sourceApiRequestId
    workingCopyRef.current = null
    setWorkingCopy(null)
    setURLDraft(displayURL(requestRef.current))
    setQueryDraft(queryText(queryRows(requestRef.current)))
    setHeaderDraft(headersText(requestRef.current))
    setBodyFormRows(bodyType(requestRef.current.body_type) === 'urlencoded'
      ? parseQueryText(requestRef.current.body ?? '')
      : [])
    setSaveState(sourceApiRequestId ? 'saved' : 'unsaved')
  }, [sourceApiRequestId])

  function replaceRequest(next: RequestData) {
    requestRef.current = next
    onChange(next)
    setSaveState(sourceRef.current ? 'modified' : 'unsaved')
  }

  function patchRequest(patch: Partial<RequestData>) {
    replaceRequest({ ...requestRef.current, ...patch })
  }

  function updateURL(value: string) {
    setURLDraft(value)
    const parsed = splitURL(value)
    setQueryDraft(queryText(parsed.queryParams))
    patchRequest({ url: parsed.url, query_params: parsed.queryParams })
  }

  function updateQueryRows(rows: RequestKeyValue[]) {
    const baseURL = splitURL(requestRef.current.url).url
    const next = { ...requestRef.current, url: baseURL, query_params: rows }
    setQueryDraft(queryText(rows))
    setURLDraft(displayURL(next))
    replaceRequest(next)
  }

  function updateRawQuery(value: string) {
    const rows = parseQueryText(value)
    const baseURL = splitURL(requestRef.current.url).url
    const next = { ...requestRef.current, url: baseURL, query_params: rows }
    setQueryDraft(value)
    setURLDraft(displayURL(next))
    replaceRequest(next)
  }

  function updateHeaderRows(rows: RequestKeyValue[]) {
    setHeaderDraft(headersText({ ...requestRef.current, headers: rows }))
    patchRequest({ headers: rows })
  }

  function updateBodyType(value: string) {
    if (value === 'none') {
      patchRequest({ body_type: 'none', body: '' })
      return
    }
    const previous = bodyType(requestRef.current.body_type)
    const switchingStructuredType =
      (value === 'urlencoded' && previous !== 'urlencoded')
      || (value === 'json' && previous === 'urlencoded')
    if (value === 'urlencoded' && previous !== 'urlencoded') setBodyFormRows([])
    patchRequest({ body_type: value, body: switchingStructuredType ? '' : requestRef.current.body })
  }

  function formatJSONBody() {
    try {
      patchRequest({ body: JSON.stringify(JSON.parse(requestRef.current.body ?? ''), null, 2), body_type: 'json' })
    } catch {
      // The validation message below keeps the malformed draft editable.
    }
  }

  async function ensureWorkingCopy(): Promise<BackendWorkingCopy> {
    if (workingCopyRef.current) return workingCopyRef.current
    if (creatingRef.current) return creatingRef.current
    const currentRequest = requestRef.current
    creatingRef.current = (sourceRef.current
      ? createWorkingCopyForRequest(sourceRef.current)
        .then((copy) => updateWorkingCopy(copy, currentRequest))
        .catch((error) => {
          if (!(error instanceof CatalogNotFoundError)) throw error
          sourceRef.current = null
          onSourceApiRequestIdChange?.(null)
          return createWorkingCopy(currentRequest, { name: apiName(currentRequest) })
        })
      : createWorkingCopy(currentRequest, { name: apiName(currentRequest) }))
      .then((copy) => {
        workingCopyRef.current = copy
        setWorkingCopy(copy)
        return copy
      })
      .finally(() => {
        creatingRef.current = null
      })
    return creatingRef.current
  }

  function syncWorkingCopy(): Promise<BackendWorkingCopy> {
    let resolveResult!: (copy: BackendWorkingCopy) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<BackendWorkingCopy>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    syncQueueRef.current = syncQueueRef.current.catch(() => {}).then(async () => {
      try {
        const current = await ensureWorkingCopy()
        const updated = await updateWorkingCopy(current, requestRef.current)
        workingCopyRef.current = updated
        setWorkingCopy(updated)
        setSaveState(updated.api_request_id && updated.content_hash === updated.base_content_hash ? 'saved' : updated.api_request_id ? 'modified' : 'unsaved')
        resolveResult(updated)
      } catch (error) {
        setSaveState(error instanceof CatalogConflictError ? 'conflict' : 'error')
        rejectResult(error)
      }
    })
    return result
  }

  useEffect(() => {
    if (!autosaveWorkingCopy) return
    if (!editedRef.current) {
      editedRef.current = true
      return
    }
    const timer = window.setTimeout(() => {
      void syncWorkingCopy()
    }, 500)
    return () => window.clearTimeout(timer)
    // Request content intentionally drives server-side draft autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, autosaveWorkingCopy])

  async function importRequest(content: string) {
    if (!content.trim()) return
    setImporting(true)
    setImportMessage(null)
    try {
      await syncQueueRef.current.catch(() => {})
      const imported = await importCurl(content)
      workingCopyRef.current = imported
      setWorkingCopy(imported)
      setURLDraft(displayURL(imported.request))
      setQueryDraft(queryText(queryRows(imported.request)))
      setHeaderDraft(headersText(imported.request))
      setBodyFormRows(bodyType(imported.request.body_type) === 'urlencoded'
        ? parseQueryText(imported.request.body ?? '')
        : [])
      setActiveTab(imported.request.body ? 'body' : queryRows(imported.request).length > 0 ? 'params' : 'headers')
      replaceRequest(imported.request)
      setSaveState('unsaved')
      setImportMessage('Imported request as an unsaved draft')
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'Could not parse request')
    } finally {
      setImporting(false)
    }
  }

  function handleURLPaste(event: ClipboardEvent<HTMLInputElement>) {
    const content = event.clipboardData.getData('text')
    const firstLine = content.trimStart().split(/\r?\n/, 1)[0].trim().replace(/^[$%#>]\s*/, '')
    const isCurl = /^curl(?:\.exe)?(?:\s|$)/i.test(firstLine)
    const isRawHTTP = /^[A-Z]+\s+\S+\s+HTTP\/1(?:\.0|\.1)$/i.test(firstLine)
    if (!isCurl && !isRawHTTP) return
    event.preventDefault()
    void importRequest(content)
  }

  async function ensureCollection() {
    const collections = await listCollections()
    return collections[0] ?? createCollection({ name: 'My Requests' })
  }

  async function saveAPI() {
    if (!requestRef.current.url.trim()) return
    setSaveState('saving')
    try {
      const draft = await syncWorkingCopy()
      const collection = draft.api_request_id ? undefined : await ensureCollection()
      const saved = await saveWorkingCopy(draft.id, {
        collection_id: collection?.id,
        name: apiName(requestRef.current),
      })
      workingCopyRef.current = saved
      sourceRef.current = saved.api_request_id
      setWorkingCopy(saved)
      setSaveState('saved')
      if (saved.api_request_id) onSourceApiRequestIdChange?.(saved.api_request_id)
      void useCatalogStore.getState().refresh()
    } catch (error) {
      setSaveState(error instanceof CatalogConflictError ? 'conflict' : 'error')
    }
  }

  async function send() {
    if (!requestRef.current.url.trim()) return
    setSending(true)
    try {
      const draft = await syncWorkingCopy()
      const result = await runWorkingCopy(draft.id)
      setRun(result)
      onRunResult?.(result)
    } catch (error) {
      const failed = {
        id: 'local-error',
        project_id: 'default',
        trigger_type: 'manual',
        status: 'failed',
        request_snapshot: requestRef.current,
        response_truncated: false,
        is_pinned: false,
        started_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : 'Network error',
      } satisfies BackendRun
      setRun(failed)
      onRunResult?.(failed)
    } finally {
      setSending(false)
    }
  }

  async function resolveConflict(mode: 'reload' | 'keep') {
    const current = workingCopyRef.current
    if (!current) return
    try {
      const latest = await getWorkingCopy(current.id)
      if (mode === 'reload') {
        workingCopyRef.current = latest
        setWorkingCopy(latest)
        setURLDraft(displayURL(latest.request))
        setQueryDraft(queryText(queryRows(latest.request)))
        setHeaderDraft(headersText(latest.request))
        setBodyFormRows(bodyType(latest.request.body_type) === 'urlencoded'
          ? parseQueryText(latest.request.body ?? '')
          : [])
        replaceRequest(latest.request)
        setSaveState(latest.api_request_id && latest.content_hash === latest.base_content_hash ? 'saved' : 'modified')
      } else {
        workingCopyRef.current = latest
        setWorkingCopy(latest)
        await syncWorkingCopy()
      }
    } catch {
      setSaveState('error')
    }
  }

  const isFormalAPI = Boolean(sourceApiRequestId ?? workingCopy?.api_request_id)
  const saveLabel =
    saveState === 'saving' ? 'Saving…'
      : saveState === 'saved' ? 'Saved'
        : saveState === 'modified' ? 'Save API changes'
          : saveState === 'error' ? 'Retry save'
            : saveState === 'conflict' ? 'Resolve conflict'
              : 'Draft · Save API'
  const method = request.method.toUpperCase()
  const bodyDisabled = method === 'GET' || method === 'HEAD'
  const params = queryRows(request)
  const headers = request.headers ?? []
  const currentBodyType = bodyType(request.body_type)
  let jsonError: string | null = null
  if (currentBodyType === 'json' && request.body?.trim()) {
    try {
      JSON.parse(request.body)
    } catch (error) {
      jsonError = error instanceof Error ? error.message : 'Invalid JSON'
    }
  }

  return (
    <div className={`mr-wrap request-workbench${compact ? ' compact' : ''}`}>
      <div className="mr-urlrow">
        <select
          className="mr-sel"
          value={method}
          onChange={(event) => patchRequest({ method: event.target.value })}
          disabled={sending}
          aria-label="Method"
        >
          {METHODS.map((item) => <option key={item}>{item}</option>)}
        </select>
        <input
          className="mr-inp"
          value={urlDraft}
          onChange={(event) => {
            setImportMessage(null)
            updateURL(event.target.value)
          }}
          onPaste={handleURLPaste}
          disabled={sending || importing}
          placeholder={importing ? 'Parsing pasted request…' : 'URL — or paste curl / raw HTTP'}
          aria-label="URL"
        />
        <button type="button" className="mr-send" onClick={() => void send()} disabled={sending || importing || !request.url.trim()}>
          {sending
            ? <><IconLoader size={12} /> Sending…</>
            : hasSent || run
              ? <><IconRefresh size={12} /> Resend</>
              : <><IconSend size={12} /> Send</>}
        </button>
        <button
          type="button"
          className={`mr-save ${isFormalAPI ? 'formal' : 'draft'} ${saveState}`}
          onClick={() => void saveAPI()}
          disabled={sending || saveState === 'saving' || saveState === 'conflict' || (isFormalAPI && saveState === 'saved')}
          title="The Flow saves automatically. This saves the request to the API Library."
        >
          {saveState === 'saving' ? <IconLoader size={12} /> : <IconDeviceFloppy size={12} />}
          {saveLabel}
        </button>
        {isFormalAPI && onOpenAPI && (
          <button type="button" className="mr-open-api" onClick={onOpenAPI} title="Open API definition">
            <IconExternalLink size={13} />
          </button>
        )}
      </div>

      {importMessage && <div className={`mr-import-msg${importMessage.startsWith('Imported') ? ' ok' : ' err'}`}>{importMessage}</div>}
      {saveState === 'conflict' && (
        <div className="mr-conflict" role="alert">
          <span>This draft changed elsewhere.</span>
          <button type="button" onClick={() => void resolveConflict('reload')}>Reload latest</button>
          <button type="button" onClick={() => void resolveConflict('keep')}>Keep mine</button>
        </div>
      )}

      <div className="mr-tabs" role="tablist" aria-label="Request configuration">
        <button type="button" role="tab" aria-selected={activeTab === 'params'} className={activeTab === 'params' ? 'active' : ''} onClick={() => setActiveTab('params')}>
          Params <span>{params.filter((item) => item.enabled && item.name).length}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'headers'} className={activeTab === 'headers' ? 'active' : ''} onClick={() => setActiveTab('headers')}>
          Headers <span>{headers.filter((item) => item.enabled && item.name).length}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'body'} className={activeTab === 'body' ? 'active' : ''} onClick={() => setActiveTab('body')}>
          Body <span>{currentBodyType === 'none' ? 'None' : BODY_TYPES.find((item) => item.value === currentBodyType)?.label}</span>
        </button>
      </div>

      <div className="mr-tab-panel" role="tabpanel">
        {activeTab === 'params' && (
          <>
            <div className="mr-editor-toolbar">
              <span>Query parameters are synchronized with the URL.</span>
              <div className="mr-mode-switch" aria-label="Params editor mode">
                <button type="button" className={paramsMode === 'form' ? 'active' : ''} onClick={() => setParamsMode('form')}>Form</button>
                <button type="button" className={paramsMode === 'raw' ? 'active' : ''} onClick={() => setParamsMode('raw')}><IconCode size={11} /> Raw</button>
              </div>
            </div>
            {paramsMode === 'form' ? (
              <KeyValueRows
                label="Parameter"
                rows={params}
                disabled={sending}
                emptyLabel="No query parameters yet."
                onChange={updateQueryRows}
              />
            ) : (
              <textarea
                className="mr-ta mr-raw-editor"
                rows={compact ? 3 : 4}
                value={queryDraft}
                onChange={(event) => updateRawQuery(event.target.value)}
                disabled={sending}
                placeholder="page=1&limit=20"
                aria-label="Raw query parameters"
              />
            )}
          </>
        )}

        {activeTab === 'headers' && (
          <>
            <div className="mr-editor-toolbar">
              <span>Headers sent with this request.</span>
              <div className="mr-mode-switch" aria-label="Headers editor mode">
                <button type="button" className={headersMode === 'form' ? 'active' : ''} onClick={() => setHeadersMode('form')}>Form</button>
                <button type="button" className={headersMode === 'raw' ? 'active' : ''} onClick={() => setHeadersMode('raw')}><IconCode size={11} /> Raw</button>
              </div>
            </div>
            {headersMode === 'form' ? (
              <KeyValueRows
                label="Header"
                rows={headers}
                disabled={sending}
                emptyLabel="No request headers yet."
                onChange={updateHeaderRows}
              />
            ) : (
              <textarea
                className="mr-ta mr-raw-editor"
                rows={compact ? 3 : 4}
                value={headerDraft}
                onChange={(event) => {
                  setHeaderDraft(event.target.value)
                  patchRequest({ headers: parseHeaders(event.target.value) })
                }}
                disabled={sending}
                placeholder="Content-Type: application/json"
                aria-label="Headers"
              />
            )}
          </>
        )}

        {activeTab === 'body' && (
          <>
            <div className="mr-body-toolbar">
              <label>
                Body type
                <select value={currentBodyType} onChange={(event) => updateBodyType(event.target.value)} disabled={sending || bodyDisabled} aria-label="Body type">
                  {BODY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              {currentBodyType === 'json' && request.body && (
                <button type="button" className="mr-format" onClick={formatJSONBody} disabled={sending || Boolean(jsonError)}>
                  <IconBraces size={12} /> Format JSON
                </button>
              )}
            </div>
            {bodyDisabled ? (
              <div className="mr-body-empty">{method} requests do not include a request body.</div>
            ) : currentBodyType === 'none' ? (
              <div className="mr-body-empty">This request has no body.</div>
            ) : currentBodyType === 'urlencoded' ? (
              <KeyValueRows
                label="Parameter"
                rows={bodyFormRows}
                disabled={sending}
                emptyLabel="No form fields yet."
                onChange={(rows) => {
                  setBodyFormRows(rows)
                  patchRequest({ body_type: 'urlencoded', body: queryText(rows) })
                }}
              />
            ) : (
              <>
                <textarea
                  className={`mr-ta mr-body-editor${jsonError ? ' invalid' : ''}`}
                  rows={compact ? 5 : 7}
                  value={request.body ?? ''}
                  onChange={(event) => patchRequest({ body: event.target.value, body_type: currentBodyType })}
                  disabled={sending}
                  placeholder={currentBodyType === 'json' ? '{\n  "key": "value"\n}' : 'Request body'}
                  aria-label="Body"
                />
                {jsonError && <div className="mr-json-error" role="alert">{jsonError}</div>}
              </>
            )}
          </>
        )}
      </div>

      {run && (
        <div className={`mr-response ${run.status === 'succeeded' ? 'ok' : 'error'}`}>
          <div className="mr-response-head">
            <strong>Response</strong>
            <span>{run.response_status ?? run.status}</span>
            {run.duration_ms != null && <span>{run.duration_ms}ms</span>}
            <div className="mr-response-tabs">
              <button type="button" className={responseTab === 'body' ? 'active' : ''} onClick={() => setResponseTab('body')}>Body</button>
              <button type="button" className={responseTab === 'headers' ? 'active' : ''} onClick={() => setResponseTab('headers')}>Headers</button>
            </div>
          </div>
          <pre className="run-pre">
            {responseTab === 'body'
              ? responseBody(run)
              : JSON.stringify(run.response_headers ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
