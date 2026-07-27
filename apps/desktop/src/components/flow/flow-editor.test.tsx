// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Flow } from '../../services/flow-client'
import { useFlowStore } from '../../store/flow-store'
import { FlowEditor, requestPath } from './flow-editor'

const flow: Flow = {
  id: 'flow-1',
  project_id: 'default',
  name: 'Checkout flow',
  description: '',
  environment_id: null,
  settings: { stop_on_error: true, request_timeout_ms: 60_000 },
  variables: [],
  steps: [{
    id: 'step-1',
    position: 0,
    type: 'http',
    name: 'Create order',
    enabled: true,
    source_api_request_id: null,
    request: {
      method: 'POST',
      url: 'https://api.example.com/orders',
      query_params: [],
      headers: [],
      body_type: 'json',
      body: '{}',
    },
    config: { continue_on_error: false, extractors: [] },
  }],
  edit_version: 1,
  created_at: '2026-07-24T00:00:00Z',
  updated_at: '2026-07-24T00:00:00Z',
  archived_at: null,
}

afterEach(cleanup)

beforeEach(() => {
  useFlowStore.setState({
    entities: { [flow.id]: flow },
    drafts: { [flow.id]: flow },
    selectedFlowId: flow.id,
    saveStateById: { [flow.id]: 'saved' },
  })
})

function renderEditor(overrides: Partial<Parameters<typeof FlowEditor>[0]> = {}) {
  const props = {
    flow,
    onSearch: vi.fn(),
    onLibrary: vi.fn(),
    onRunHistory: vi.fn(),
    ...overrides,
  }
  return { ...render(<FlowEditor {...props} />), props }
}

function renderStoreBackedEditor(overrides: Partial<Parameters<typeof FlowEditor>[0]> = {}) {
  const props = {
    onSearch: vi.fn(),
    onLibrary: vi.fn(),
    onRunHistory: vi.fn(),
    onChooseAPI: vi.fn(),
    ...overrides,
  }
  function Harness() {
    const draft = useFlowStore((state) => state.drafts[flow.id])
    return <FlowEditor flow={draft} {...props} />
  }
  return { ...render(<Harness />), props }
}

describe('FlowEditor visual shell', () => {
  it('keeps Flow state separate from workspace commands', async () => {
    const user = userEvent.setup()
    const { props } = renderEditor()

    expect(screen.getByRole('status').textContent).toContain('Saved')
    expect(screen.queryByText('Runtime 在线')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开接口库' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开请求历史' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '搜索接口' }))
    expect(props.onSearch).toHaveBeenCalledOnce()
  })

  it('renders Flow steps with the original timeline, card and per-request save action', async () => {
    const user = userEvent.setup()
    const { container } = renderEditor()

    expect(container.querySelector('.flow-timeline.tl')).toBeTruthy()
    expect(container.querySelector('.flow-definition-step.step')).toBeTruthy()
    expect(container.querySelector('.flow-definition-card.card')).toBeTruthy()
    expect(screen.getByText('POST')).toBeTruthy()
    expect(screen.getByText('/orders')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Step name' })).toBeNull()
    expect(screen.getByRole('button', { name: /Add next step/ })).toBeTruthy()

    const cardHeader = container.querySelector<HTMLElement>('.flow-definition-head')
    expect(cardHeader).toBeTruthy()
    await user.click(cardHeader!)
    expect(screen.getByRole('button', { name: 'Draft · Save API' })).toBeTruthy()
  })

  it('derives the stored step label from the editable request URL', () => {
    expect(requestPath('https://api.example.com/users/42?expand=team')).toBe('/users/42')
    expect(requestPath('{{base_url}}/users/{{user_id}}')).toBe('/users/{{user_id}}')
    expect(requestPath('')).toBe('New request')
  })

  it('shows an expanded blank API card for an empty Flow', () => {
    vi.useFakeTimers()
    const emptyFlow = { ...flow, steps: [] }
    useFlowStore.setState({
      entities: { [flow.id]: emptyFlow },
      drafts: { [flow.id]: emptyFlow },
      selectedFlowId: flow.id,
      saveStateById: { [flow.id]: 'saved' },
    })

    renderStoreBackedEditor()

    expect(screen.queryByText(/This flow has no steps yet/)).toBeNull()
    expect(screen.getByText('New request')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Draft · Save API' })).toBeTruthy()
    expect(useFlowStore.getState().drafts[flow.id].steps).toHaveLength(1)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('adds and opens a blank API card from the Add next step action', () => {
    vi.useFakeTimers()
    renderStoreBackedEditor()

    fireEvent.click(screen.getByRole('button', { name: /Add next step/ }))

    expect(useFlowStore.getState().drafts[flow.id].steps).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Draft · Save API' })).toHaveLength(1)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('opens API selection from the library action inside Add next step', async () => {
    const user = userEvent.setup()
    const onChooseAPI = vi.fn()
    renderEditor({ onChooseAPI })

    await user.click(screen.getByRole('button', { name: '从现有 API 库创建' }))

    expect(onChooseAPI).toHaveBeenCalledOnce()
    expect(screen.getByRole('complementary', { name: 'Flow details' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Flow' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Rules' })).toBeTruthy()
  })
})
