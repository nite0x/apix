import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { IconDeviceFloppy, IconLoader, IconRefresh, IconSend } from '@tabler/icons-react'
import { useSessionStore } from '../../store/session-store'

const API_BASE = 'http://127.0.0.1:4317/api'

interface KeyValue {
  name: string
  value: string
  enabled: boolean
}

interface RequestData {
  method: string
  url: string
  query_params: KeyValue[]
  headers: KeyValue[]
  body_type: string
  body?: string
}

interface WorkingCopy {
  id: string
  api_request_id?: string
  name?: string
  request: RequestData
  content_hash: string
  base_content_hash?: string
  edit_version: number
}

interface APIRun {
  id: string
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  response_status?: number
  response_body?: unknown
  duration_ms?: number
  error_message?: string
}

interface APICollection {
  id: string
  name: string
}

interface Props {
  sessionId: string
  stepId: string
}

export function ManualForm({ sessionId, stepId }: Props) {
  const initialStep = useSessionStore((state) => state.sessions.find((session) => session.id === sessionId)?.steps.find((step) => step.id === stepId))
  const [method, setMethod] = useState(initialStep?.method ?? 'GET')
  const [url, setUrl] = useState(initialStep?.url ?? 'http://127.0.0.1:4317/health')
  const [body, setBody] = useState('{\n  "email": "admin@example.com",\n  "password": "secret123"\n}')
  const [headersText, setHeadersText] = useState('')
  const [workingCopy, setWorkingCopy] = useState<WorkingCopy | null>(null)
  const workingCopyRef = useRef<WorkingCopy | null>(null)
  const creatingRef = useRef<Promise<WorkingCopy> | null>(null)
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [saveState, setSaveState] = useState<'unsaved' | 'saved' | 'modified' | 'saving' | 'error'>('unsaved')
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const hasSent = useSessionStore((s) => {
    const step = s.sessions.find((sess) => sess.id === sessionId)?.steps.find((st) => st.id === stepId)
    return step?.responseBody != null
  })
  const store = useSessionStore()

  useEffect(() => { workingCopyRef.current = workingCopy }, [workingCopy])

  function requestData(): RequestData {
    return {
      method,
      url,
      query_params: [],
      headers: parseHeaders(),
      body_type: body && method !== 'GET' ? 'json' : 'none',
      body: method !== 'GET' ? body : '',
    }
  }

  async function parseJSON<T>(res: Response): Promise<T> {
    const data = await res.json() as T & { error?: string }
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
    return data
  }

  async function ensureWorkingCopy(): Promise<WorkingCopy> {
    if (workingCopyRef.current) return workingCopyRef.current
    if (creatingRef.current) return creatingRef.current
    creatingRef.current = fetch(`${API_BASE}/working-copies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: requestData(), source_type: 'manual' }),
    }).then((res) => parseJSON<WorkingCopy>(res)).then((copy) => {
      workingCopyRef.current = copy
      setWorkingCopy(copy)
      return copy
    }).finally(() => { creatingRef.current = null })
    return creatingRef.current
  }

  function syncWorkingCopy(): Promise<WorkingCopy> {
    let resolveResult!: (value: WorkingCopy) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<WorkingCopy>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    syncQueueRef.current = syncQueueRef.current.then(async () => {
      try {
        const current = await ensureWorkingCopy()
        const updated = await fetch(`${API_BASE}/working-copies/${current.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...current, request: requestData(), edit_version: current.edit_version }),
        }).then((res) => parseJSON<WorkingCopy>(res))
        workingCopyRef.current = updated
        setWorkingCopy(updated)
        setSaveState(updated.api_request_id
          ? updated.content_hash === updated.base_content_hash ? 'saved' : 'modified'
          : 'unsaved')
        resolveResult(updated)
      } catch (error) {
        rejectResult(error)
      }
    })
    return result
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!workingCopyRef.current) return
      void syncWorkingCopy().catch(() => setSaveState('error'))
    }, 500)
    return () => window.clearTimeout(timer)
    // The editable request fields intentionally drive server-side draft autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, url, body, headersText])

  async function importRequest(content: string) {
    if (!content.trim()) return
    setImporting(true)
    setImportMessage(null)
    try {
      await syncQueueRef.current
      const imported = await fetch(`${API_BASE}/import/curl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }).then((res) => parseJSON<WorkingCopy>(res))

      workingCopyRef.current = imported
      setWorkingCopy(imported)
      setMethod(imported.request.method)
      setUrl(imported.request.url)
      setHeadersText(imported.request.headers.map(({ name, value }) => `${name}: ${value}`).join('\n'))
      setBody(imported.request.body ?? '')
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

  function parseHeaders(): KeyValue[] {
    const headers: KeyValue[] = []
    for (const line of headersText.split('\n')) {
      if (!line.trim()) continue
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      headers.push({ name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim(), enabled: true })
    }
    return headers
  }

  async function ensureCollection(): Promise<APICollection> {
    const collections = await fetch(`${API_BASE}/collections`).then((res) => parseJSON<APICollection[]>(res))
    if (collections.length > 0) return collections[0]
    return fetch(`${API_BASE}/collections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'My Requests' }),
    }).then((res) => parseJSON<APICollection>(res))
  }

  async function saveAPI() {
    setSaveState('saving')
    try {
      const draft = await syncWorkingCopy()
      const collection = await ensureCollection()
      const path = new URL(url).pathname || '/'
      const saved = await fetch(`${API_BASE}/working-copies/${draft.id}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: collection.id, name: draft.name || `${method} ${path}` }),
      }).then((res) => parseJSON<WorkingCopy>(res))
      workingCopyRef.current = saved
      setWorkingCopy(saved)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }

  async function send() {
    setSending(true)
    store.updateStep(sessionId, stepId, { status: 'running' })
    try {
      const draft = await syncWorkingCopy()
      const result = await fetch(`${API_BASE}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ working_copy_id: draft.id }),
      }).then((res) => parseJSON<APIRun>(res))
      store.updateStep(sessionId, stepId, {
        status: result.status === 'succeeded' ? 'done' : 'error',
        method,
        url,
        requestBody: method !== 'GET' ? body : undefined,
        statusCode: result.response_status,
        durationMs: result.duration_ms,
        responseBody: result.error_message ?? (typeof result.response_body === 'string'
          ? result.response_body
          : JSON.stringify(result.response_body ?? null, null, 2)),
      })
      store.updateSession(sessionId, { name: `${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`, status: 'idle' })
    } catch (error) {
      store.updateStep(sessionId, stepId, {
        status: 'error', method, url, requestBody: method !== 'GET' ? body : undefined,
        responseBody: error instanceof Error ? error.message : 'Network error - could not reach server',
      })
    } finally {
      setSending(false)
    }
  }

  const saveLabel = saveState === 'saved' ? 'Saved' : saveState === 'modified' ? 'Unsaved changes' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Unsaved'

  return (
    <div className="mr-wrap">
      <div className="mr-state-row">
        <span className={`mr-save-state ${saveState}`}>{saveLabel}</span>
        <button className="mr-save" onClick={() => void saveAPI()} disabled={sending || saveState === 'saving' || saveState === 'saved'}>
          <IconDeviceFloppy size={12} /> {workingCopy?.api_request_id ? 'Save changes' : 'Save API'}
        </button>
      </div>
      <div className="mr-urlrow">
        <select className="mr-sel" value={method} onChange={(e) => { setMethod(e.target.value); setSaveState(workingCopy?.api_request_id ? 'modified' : 'unsaved') }} disabled={sending}>
          {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((item) => <option key={item}>{item}</option>)}
        </select>
        <input className="mr-inp" value={url} onChange={(e) => { setUrl(e.target.value); setImportMessage(null); setSaveState(workingCopy?.api_request_id ? 'modified' : 'unsaved') }}
          onPaste={handleURLPaste} disabled={sending || importing} placeholder={importing ? 'Parsing pasted request…' : 'URL — or paste curl / raw HTTP'} />
      </div>
      {importMessage && <div className={`mr-import-msg${importMessage.startsWith('Imported') ? ' ok' : ' err'}`}>{importMessage}</div>}
      <textarea className="mr-ta mr-headers" rows={2} value={headersText} onChange={(e) => { setHeadersText(e.target.value); setSaveState(workingCopy?.api_request_id ? 'modified' : 'unsaved') }}
        disabled={sending} placeholder="Headers (one Name: Value per line)" />
      <textarea className="mr-ta" rows={3} value={body} onChange={(e) => { setBody(e.target.value); setSaveState(workingCopy?.api_request_id ? 'modified' : 'unsaved') }}
        disabled={sending || method === 'GET'} placeholder={method === 'GET' ? '(no body for GET)' : 'Request body (JSON)'} />
      <button className="mr-send" onClick={() => void send()} disabled={sending || importing || !url}>
        {sending ? <><IconLoader size={12} /> Sending…</> : hasSent ? <><IconRefresh size={12} /> Resend</> : <><IconSend size={12} /> Send</>}
      </button>
    </div>
  )
}
