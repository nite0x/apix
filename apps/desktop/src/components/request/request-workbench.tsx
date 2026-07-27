import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import {
  IconDeviceFloppy,
  IconExternalLink,
  IconLoader,
  IconRefresh,
  IconSend,
} from '@tabler/icons-react'
import type { RequestData } from '../../data/api-catalog'
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
  const [run, setRun] = useState<BackendRun | null>(null)
  const [headerDraft, setHeaderDraft] = useState(() => headersText(request))

  useEffect(() => {
    requestRef.current = request
  }, [request])

  useEffect(() => {
    if (sourceRef.current === sourceApiRequestId) return
    sourceRef.current = sourceApiRequestId
    workingCopyRef.current = null
    setWorkingCopy(null)
    setHeaderDraft(headersText(requestRef.current))
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
      setHeaderDraft(headersText(imported.request))
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
        setHeaderDraft(headersText(latest.request))
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
          value={request.url}
          onChange={(event) => {
            setImportMessage(null)
            patchRequest({ url: event.target.value })
          }}
          onPaste={handleURLPaste}
          disabled={sending || importing}
          placeholder={importing ? 'Parsing pasted request…' : 'URL — or paste curl / raw HTTP'}
          aria-label="URL"
        />
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

      <textarea
        className="mr-ta mr-headers"
        rows={2}
        value={headerDraft}
        onChange={(event) => {
          setHeaderDraft(event.target.value)
          patchRequest({ headers: parseHeaders(event.target.value) })
        }}
        disabled={sending}
        placeholder="Headers (one Name: Value per line)"
        aria-label="Headers"
      />
      <textarea
        className="mr-ta"
        rows={compact ? 3 : 4}
        value={request.body ?? ''}
        onChange={(event) => patchRequest({
          body: event.target.value,
          body_type: event.target.value ? 'json' : 'none',
        })}
        disabled={sending || bodyDisabled}
        placeholder={bodyDisabled ? '(no body for this method)' : 'Request body (JSON)'}
        aria-label="Body"
      />
      <button type="button" className="mr-send" onClick={() => void send()} disabled={sending || importing || !request.url.trim()}>
        {sending
          ? <><IconLoader size={12} /> Sending…</>
          : hasSent || run
            ? <><IconRefresh size={12} /> Resend</>
            : <><IconSend size={12} /> Send</>}
      </button>

      {run && (
        <div className={`mr-response ${run.status === 'succeeded' ? 'ok' : 'error'}`}>
          <div className="mr-response-head">
            <strong>Response</strong>
            <span>{run.response_status ?? run.status}</span>
            {run.duration_ms != null && <span>{run.duration_ms}ms</span>}
          </div>
          <pre className="run-pre">{responseBody(run)}</pre>
        </div>
      )}
    </div>
  )
}
