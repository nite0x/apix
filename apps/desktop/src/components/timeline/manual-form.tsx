import { useState } from 'react'
import { IconSend, IconRefresh, IconLoader } from '@tabler/icons-react'
import { useSessionStore } from '../../store/session-store'
import type { Step } from '../../store/session-store'

interface Props {
  sessionId: string
  stepId: string
}

export function ManualForm({ sessionId, stepId }: Props) {
  const [method, setMethod] = useState('POST')
  const [url, setUrl] = useState('https://api.example.com/auth/login')
  const [body, setBody] = useState('{\n  "email": "admin@example.com",\n  "password": "secret123"\n}')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const store = useSessionStore()

  async function send() {
    setSending(true)
    const start = Date.now()
    try {
      const res = await fetch('http://127.0.0.1:4317/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, url, body }),
      })
      const data = await res.json() as Record<string, unknown>
      const ms = Date.now() - start
      store.updateStep(sessionId, stepId, { status: 'done' })
      const resultStep: Step = {
        id: `${stepId}-result`,
        type: 'http',
        status: 'done',
        method,
        url,
        statusCode: data.statusCode as number ?? res.status,
        durationMs: ms,
        responseBody: typeof data.body === 'string' ? data.body : JSON.stringify(data.body ?? data, null, 2),
      }
      store.addStep(sessionId, resultStep)
      store.updateSession(sessionId, { name: `${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`, status: 'idle' })
      setSent(true)
    } catch {
      const ms = Date.now() - start
      store.updateStep(sessionId, stepId, { status: 'done' })
      const resultStep: Step = {
        id: `${stepId}-result`,
        type: 'http',
        status: 'error',
        method,
        url,
        durationMs: ms,
        responseBody: 'Network error - could not reach server',
      }
      store.addStep(sessionId, resultStep)
      setSent(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mr-wrap">
      <div className="mr-urlrow">
        <select className="mr-sel" value={method} onChange={(e) => setMethod(e.target.value)} disabled={sent}>
          <option>POST</option>
          <option>GET</option>
          <option>PUT</option>
          <option>DELETE</option>
          <option>PATCH</option>
        </select>
        <input className="mr-inp" value={url} onChange={(e) => setUrl(e.target.value)} disabled={sent} />
      </div>
      <textarea
        className="mr-ta"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={sent || method === 'GET'}
        placeholder={method === 'GET' ? '(no body for GET)' : 'Request body (JSON)'}
      />
      <button className="mr-send" onClick={send} disabled={sending}>
        {sending ? (
          <><IconLoader size={12} /> Sending…</>
        ) : sent ? (
          <><IconRefresh size={12} /> Resend</>
        ) : (
          <><IconSend size={12} /> Send</>
        )}
      </button>
    </div>
  )
}
