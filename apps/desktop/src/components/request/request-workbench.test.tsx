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

  it('keeps URL query parameters synchronized with the Params form', () => {
    function QueryHarness() {
      const [request, setRequest] = useState<RequestData>({
        ...emptyRequest,
        url: 'https://api.example.com/users?page=1',
      })
      return <RequestWorkbench request={request} onChange={setRequest} autosaveWorkingCopy={false} />
    }

    render(<QueryHarness />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'URL' }).value).toBe('https://api.example.com/users?page=1')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Parameter key 1' }).value).toBe('page')

    fireEvent.click(screen.getByRole('button', { name: '添加参数' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Parameter key 2' }), {
      target: { value: 'limit' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Parameter value 2' }), {
      target: { value: '20' },
    })

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'URL' }).value)
      .toBe('https://api.example.com/users?page=1&limit=20')

    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: 'https://api.example.com/users?role=admin&role=owner' },
    })
    expect(screen.getAllByDisplayValue('role')).toHaveLength(2)
  })

  it('edits headers as rows while retaining a Raw editor', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }))
    fireEvent.click(screen.getByRole('button', { name: '添加 Header' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Header key 1' }), {
      target: { value: 'Content-Type' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Header value 1' }), {
      target: { value: 'application/json' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Raw/ }))

    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Headers' }).value)
      .toBe('Content-Type: application/json')
  })

  it('shows body types and validates JSON without hiding the draft', () => {
    function BodyHarness() {
      const [request, setRequest] = useState<RequestData>({
        ...emptyRequest,
        method: 'POST',
        url: 'https://api.example.com/users',
        body_type: 'json',
        body: '{"name":',
      })
      return <RequestWorkbench request={request} onChange={setRequest} autosaveWorkingCopy={false} />
    }

    render(<BodyHarness />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Body type' }).value).toBe('json')
    expect(screen.getByRole('alert').textContent).toContain('JSON')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Body' }).value).toBe('{"name":')

    fireEvent.change(screen.getByRole('combobox', { name: 'Body type' }), {
      target: { value: 'urlencoded' },
    })
    expect(screen.getByText('No form fields yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '添加参数' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Parameter key 1' }), {
      target: { value: 'name' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Parameter value 1' }), {
      target: { value: 'Ada' },
    })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Parameter key 1' }).value).toBe('name')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Parameter value 1' }).value).toBe('Ada')
  })
})
