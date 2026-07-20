// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiDefinition } from '../../data/api-catalog'
import { ApiEditor } from './api-editor'

const apiMocks = vi.hoisted(() => ({
  createRequest: vi.fn(),
  createWorkingCopyForRequest: vi.fn(),
  discardWorkingCopy: vi.fn(),
  getRequest: vi.fn(),
  saveWorkingCopy: vi.fn(),
  updateWorkingCopy: vi.fn(),
}))

const importedCopy = {
  id: 'wc-import',
  project_id: 'default',
  owner_id: 'local',
  api_request_id: undefined,
  request: {
    method: 'POST',
    url: 'https://api.example.com/users',
    query_params: [],
    headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
    body_type: 'json',
    body: '{"name":"Ada"}',
  },
  source_type: 'curl_import',
  status: 'active',
  content_hash: 'h',
  edit_version: 1,
}

const importCollections = [
  { id: 'collection-1', name: 'Saved APIs' },
  { id: 'collection-2', name: 'Team' },
]

vi.mock('../../services/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/api-client')>(),
  ...apiMocks,
}))

const savedApi: ApiDefinition = {
  id: 'request-1',
  collectionId: 'collection-1',
  collectionName: 'Saved APIs',
  name: 'List users',
  method: 'GET',
  url: 'https://api.example.com/users',
  description: 'Lists users.',
  source: 'backend',
  requestData: {
    method: 'GET',
    url: 'https://api.example.com/users',
    query_params: [{ id: 'q-1', name: 'disabled', value: '1', enabled: false }],
    headers: [],
    body_type: 'none',
    body: '',
  },
  parameters: [],
  bindings: [],
  rules: [],
  history: [],
}

const draft = {
  id: 'wc-1',
  project_id: 'default',
  owner_id: 'local',
  api_request_id: savedApi.id,
  request: savedApi.requestData!,
  source_type: 'manual',
  status: 'active',
  content_hash: 'hash',
  base_content_hash: 'hash',
  edit_version: 1,
}

function mutationRunner<T>(mutation: () => Promise<T>): Promise<T> {
  return mutation()
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ApiEditor', () => {
  it('creates a durable request with the entered fields', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    apiMocks.createRequest.mockResolvedValue({ id: 'request-new' })

    render(
      <ApiEditor
        mode="create"
        collectionId="collection-1"
        collectionName="Saved APIs"
        onCatalogMutation={mutationRunner}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    )

    await user.type(screen.getByPlaceholderText('接口名称'), 'Create user')
    await user.type(screen.getByPlaceholderText('接口说明（可选）'), 'Creates one user')
    await user.type(screen.getByPlaceholderText('https://api.example.com/path'), 'https://api.example.com/users')
    expect(screen.getByText('未保存修改')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(apiMocks.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      collection_id: 'collection-1',
      name: 'Create user',
      description: 'Creates one user',
      request: expect.objectContaining({ method: 'GET', url: 'https://api.example.com/users' }),
    })))
    expect(onSaved).toHaveBeenCalledWith('request-new', undefined)
  })

  it('marks edits as dirty and discards them back to the saved value', async () => {
    const user = userEvent.setup()
    render(
      <ApiEditor
        mode="edit"
        collectionId="collection-1"
        collectionName="Saved APIs"
        api={savedApi}
        onCatalogMutation={mutationRunner}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const description = screen.getByPlaceholderText('接口说明（可选）')
    await user.clear(description)
    await user.type(description, 'Changed')
    expect(screen.getByText('未保存修改')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '丢弃修改' }))
    expect((description as HTMLTextAreaElement).value).toBe('Lists users.')
    expect(screen.queryByText('未保存修改')).toBeNull()
  })

  it('shows conflict recovery and keeps the local form without leaking the stale draft', async () => {
    const { CatalogConflictError } = await import('../../services/api-client')
    const user = userEvent.setup()
    apiMocks.createWorkingCopyForRequest.mockResolvedValue(draft)
    apiMocks.updateWorkingCopy.mockRejectedValue(new CatalogConflictError('saved request changed'))
    apiMocks.discardWorkingCopy.mockResolvedValue(undefined)

    render(
      <ApiEditor
        mode="edit"
        collectionId="collection-1"
        collectionName="Saved APIs"
        api={savedApi}
        onCatalogMutation={mutationRunner}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const url = screen.getByPlaceholderText('https://api.example.com/path')
    await user.clear(url)
    await user.type(url, 'https://api.example.com/users?v=2')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect((await screen.findByRole('alert')).textContent).toContain('已在别处被修改')
    await user.click(screen.getByRole('button', { name: '保留本地副本' }))

    await waitFor(() => expect(apiMocks.discardWorkingCopy).toHaveBeenCalledWith('wc-1'))
    expect((url as HTMLInputElement).value).toBe('https://api.example.com/users?v=2')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ApiEditor import mode', () => {
  function renderImport(overrides: { onSaved?: () => void; onCancel?: () => void } = {}) {
    return render(
      <ApiEditor
        mode="import"
        collectionId="collection-1"
        collectionName="Saved APIs"
        importedCopy={importedCopy}
        collections={importCollections}
        onCatalogMutation={mutationRunner}
        onSaved={overrides.onSaved ?? vi.fn()}
        onCancel={overrides.onCancel ?? vi.fn()}
      />,
    )
  }

  it('seeds the parsed request, requires a collection + name, then promotes the draft', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    apiMocks.updateWorkingCopy.mockResolvedValue({ ...importedCopy, edit_version: 2 })
    apiMocks.saveWorkingCopy.mockResolvedValue({ ...importedCopy, api_request_id: 'request-new', edit_version: 3 })
    apiMocks.discardWorkingCopy.mockResolvedValue(undefined)

    renderImport({ onSaved })

    expect(screen.getByDisplayValue('https://api.example.com/users')).toBeTruthy()
    expect(screen.getByText('未保存导入')).toBeTruthy()

    const [collectionSelect] = screen.getAllByRole('combobox')
    await user.selectOptions(collectionSelect, 'collection-2')
    await user.type(screen.getByPlaceholderText('接口名称'), 'List users')
    await user.click(screen.getByRole('button', { name: '保存到接口库' }))

    await waitFor(() => expect(apiMocks.updateWorkingCopy).toHaveBeenCalledWith(
      importedCopy,
      expect.objectContaining({ method: 'POST', url: 'https://api.example.com/users' }),
    ))
    expect(apiMocks.saveWorkingCopy).toHaveBeenCalledWith('wc-import', {
      collection_id: 'collection-2',
      name: 'List users',
      description: '',
    })
    await waitFor(() => expect(apiMocks.discardWorkingCopy).toHaveBeenCalledWith('wc-import'))
    expect(onSaved).toHaveBeenCalledWith('request-new', 'collection-2')
  })

  it('discards the imported draft on an explicit discard', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    apiMocks.discardWorkingCopy.mockResolvedValue(undefined)

    renderImport({ onCancel })
    await user.click(screen.getByRole('button', { name: '丢弃导入' }))

    await waitFor(() => expect(apiMocks.discardWorkingCopy).toHaveBeenCalledWith('wc-import'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('confirms before discarding an unsaved import on close', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    apiMocks.discardWorkingCopy.mockResolvedValue(undefined)

    renderImport({ onCancel })
    await user.click(screen.getByRole('button', { name: '取消' }))

    const dialog = screen.getByRole('alertdialog', { name: '放弃导入' })
    expect(dialog).toBeTruthy()
    expect(apiMocks.discardWorkingCopy).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '放弃导入' }))
    await waitFor(() => expect(apiMocks.discardWorkingCopy).toHaveBeenCalledWith('wc-import'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('shows a recoverable conflict when the save hits a 409', async () => {
    const { CatalogConflictError } = await import('../../services/api-client')
    const user = userEvent.setup()
    apiMocks.updateWorkingCopy.mockRejectedValue(new CatalogConflictError('draft changed'))

    renderImport()
    await user.type(screen.getByPlaceholderText('接口名称'), 'List users')
    await user.click(screen.getByRole('button', { name: '保存到接口库' }))

    expect((await screen.findByRole('alert')).textContent).toContain('已在别处被修改')
  })
})
