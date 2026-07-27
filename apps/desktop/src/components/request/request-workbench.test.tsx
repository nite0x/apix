// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestData } from '../../data/api-catalog'
import { RequestWorkbench } from './request-workbench'

const emptyRequest: RequestData = {
  method: 'GET',
  url: '',
  query_params: [],
  headers: [],
  body_type: 'none',
  body: '',
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function Harness() {
  const [request, setRequest] = useState(emptyRequest)
  return <RequestWorkbench request={request} onChange={setRequest} />
}

function FlowHarness() {
  const [first, setFirst] = useState(emptyRequest)
  const [second, setSecond] = useState(emptyRequest)
  return (
    <>
      <RequestWorkbench request={first} onChange={setFirst} autosaveWorkingCopy={false} />
      <RequestWorkbench request={second} onChange={setSecond} autosaveWorkingCopy={false} />
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RequestWorkbench', () => {
  it('keeps Flow request drafts isolated without background Working Copy sync', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<FlowHarness />)

    const urlInputs = screen.getAllByRole<HTMLInputElement>('textbox', { name: 'URL' })
    fireEvent.change(urlInputs[0], { target: { value: 'https://api.example.com/first' } })
    await vi.advanceTimersByTimeAsync(550)
    fireEvent.change(urlInputs[1], { target: { value: 'https://api.example.com/second' } })
    await vi.advanceTimersByTimeAsync(550)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText('This draft changed elsewhere.')).toBeNull()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('imports pasted cURL into the editable unsaved draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      id: 'wc-import',
      project_id: 'default',
      owner_id: 'local',
      request: {
        method: 'POST',
        url: 'https://api.example.com/orders',
        query_params: [],
        headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
        body_type: 'json',
        body: '{"quantity":2}',
      },
      source_type: 'curl_import',
      status: 'active',
      content_hash: 'hash',
      edit_version: 1,
    })))

    render(<Harness />)
    fireEvent.paste(screen.getByRole('textbox', { name: 'URL' }), {
      clipboardData: { getData: () => 'curl -X POST https://api.example.com/orders -d \'{"quantity":2}\'' },
    })

    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'URL' }).value).toBe('https://api.example.com/orders'))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Method' }).value).toBe('POST')
    expect(screen.getByText('Imported request as an unsaved draft')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Draft · Save API' })).toBeTruthy()
  })
})
