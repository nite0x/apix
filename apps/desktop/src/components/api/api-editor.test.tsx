// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    expect(onSaved).toHaveBeenCalledWith('request-new')
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
