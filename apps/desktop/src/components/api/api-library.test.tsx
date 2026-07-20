// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiCollectionGroup } from '../../data/api-catalog'
import { ApiLibrary } from './api-library'

const apiMocks = vi.hoisted(() => ({
  archiveRequest: vi.fn(),
  discardWorkingCopy: vi.fn().mockResolvedValue(undefined),
  importCurl: vi.fn(),
}))

vi.mock('../../services/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/api-client')>(),
  ...apiMocks,
}))

const catalog: ApiCollectionGroup[] = [{
  id: 'collection-1',
  name: 'Saved APIs',
  icon: 'file',
  apis: [{
    id: 'request-1',
    collectionId: 'collection-1',
    collectionName: 'Saved APIs',
    name: 'List users',
    method: 'GET',
    url: 'https://api.example.com/users',
    description: 'Lists users.',
    source: 'backend',
    requestData: { method: 'GET', url: 'https://api.example.com/users' },
    parameters: [],
    bindings: [],
    rules: [],
    history: [],
  }],
}]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ApiLibrary archive flow', () => {
  it('requires confirmation and archives through the shared catalog mutation', async () => {
    const user = userEvent.setup()
    const onCatalogMutation = vi.fn(async (mutation: () => Promise<void>) => mutation())
    apiMocks.archiveRequest.mockResolvedValue(undefined)

    render(
      <ApiLibrary
        catalog={catalog}
        catalogState="ready"
        catalogError={null}
        isPreview={false}
        onClose={vi.fn()}
        onJumpToSession={vi.fn()}
        onRetry={vi.fn()}
        onCatalogMutation={onCatalogMutation}
      />,
    )

    await user.click(screen.getByRole('button', { name: '归档' }))
    const dialog = screen.getByRole('alertdialog', { name: '确认归档' })
    expect(within(dialog).getByText(/List users/)).toBeTruthy()
    expect(apiMocks.archiveRequest).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '归档' }))

    await waitFor(() => expect(apiMocks.archiveRequest).toHaveBeenCalledWith('request-1'))
    expect(onCatalogMutation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('ApiLibrary import flow', () => {
  function renderLibrary(overrides: { onClose?: () => void } = {}) {
    return render(
      <ApiLibrary
        catalog={catalog}
        catalogState="ready"
        catalogError={null}
        isPreview={false}
        onClose={overrides.onClose ?? vi.fn()}
        onJumpToSession={vi.fn()}
        onRetry={vi.fn()}
        onCatalogMutation={vi.fn(async (mutation: () => Promise<void>) => mutation())}
      />,
    )
  }

  it('opens an editable import editor seeded from the parsed draft', async () => {
    const user = userEvent.setup()
    apiMocks.importCurl.mockResolvedValue({
      id: 'wc-import',
      project_id: 'default',
      owner_id: 'local',
      request: {
        method: 'POST',
        url: 'https://api.example.com/items',
        query_params: [],
        headers: [],
        body_type: 'json',
        body: '{}',
      },
      source_type: 'curl_import',
      status: 'active',
      content_hash: 'h',
      edit_version: 1,
    })

    renderLibrary()

    await user.click(screen.getByRole('button', { name: '导入' }))
    await user.type(screen.getByPlaceholderText('Paste curl or raw HTTP request…'), 'curl -XPOST https://api.example.com/items')
    await user.click(screen.getByRole('button', { name: 'Import as draft' }))

    expect(await screen.findByText('导入接口')).toBeTruthy()
    expect(screen.getByDisplayValue('https://api.example.com/items')).toBeTruthy()
    expect(within(screen.getAllByRole('combobox')[0]).getByRole('option', { name: 'Saved APIs' })).toBeTruthy()
  })

  it('shows a recoverable message when parsing fails and keeps the editor closed', async () => {
    const user = userEvent.setup()
    apiMocks.importCurl.mockRejectedValue(new Error('expected a curl command'))

    renderLibrary()

    await user.click(screen.getByRole('button', { name: '导入' }))
    await user.type(screen.getByPlaceholderText('Paste curl or raw HTTP request…'), 'nonsense')
    await user.click(screen.getByRole('button', { name: 'Import as draft' }))

    expect(await screen.findByText('expected a curl command')).toBeTruthy()
    expect(screen.queryByText('导入接口')).toBeNull()
  })

  it('confirms before the library close path discards an imported draft', async () => {
    const user = userEvent.setup()
    const imported = {
      id: 'wc-import',
      project_id: 'default',
      owner_id: 'local',
      request: { method: 'GET', url: 'https://api.example.com/items', body_type: 'none', body: '' },
      source_type: 'curl_import',
      status: 'active',
      content_hash: 'h',
      edit_version: 1,
    }
    apiMocks.importCurl.mockResolvedValue(imported)
    apiMocks.discardWorkingCopy.mockResolvedValue(undefined)

    let view: ReturnType<typeof render>
    const onClose = vi.fn(() => view.unmount())
    view = renderLibrary({ onClose })

    await user.click(screen.getByRole('button', { name: '导入' }))
    await user.type(screen.getByPlaceholderText('Paste curl or raw HTTP request…'), 'curl https://api.example.com/items')
    await user.click(screen.getByRole('button', { name: 'Import as draft' }))
    await screen.findByText('导入接口')

    await user.click(screen.getByRole('button', { name: 'Close API library' }))
    const dialog = screen.getByRole('alertdialog', { name: '放弃导入' })
    expect(onClose).not.toHaveBeenCalled()
    expect(apiMocks.discardWorkingCopy).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '放弃导入' }))
    expect(onClose).toHaveBeenCalledOnce()
    await waitFor(() => expect(apiMocks.discardWorkingCopy).toHaveBeenCalledWith('wc-import'))
  })
})
