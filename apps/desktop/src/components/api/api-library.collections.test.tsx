// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiCollectionGroup } from '../../data/api-catalog'
import { ApiLibrary } from './api-library'

const apiMocks = vi.hoisted(() => ({
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  archiveCollection: vi.fn(),
  archiveRequest: vi.fn(),
  importCurl: vi.fn(),
  discardWorkingCopy: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/api-client')>(),
  ...apiMocks,
}))

function group(id: string, name: string): ApiCollectionGroup {
  return { id, name, icon: 'file', apis: [] }
}

const twoCollections: ApiCollectionGroup[] = [group('c-1', 'Auth'), group('c-2', 'Users')]

function renderLibrary(catalog: ApiCollectionGroup[], extra: Partial<Parameters<typeof ApiLibrary>[0]> = {}) {
  const onCatalogMutation = vi.fn(async (mutation: () => Promise<void>) => mutation())
  render(
    <ApiLibrary
      catalog={catalog}
      catalogState={catalog.length === 0 ? 'empty' : 'ready'}
      catalogError={null}
      isPreview={false}
      onClose={vi.fn()}
      onJumpToSession={vi.fn()}
      onRetry={vi.fn()}
      onCatalogMutation={onCatalogMutation}
      {...extra}
    />,
  )
  return { onCatalogMutation }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ApiLibrary collection management', () => {
  it('creates the first collection from the empty-state CTA', async () => {
    const user = userEvent.setup()
    apiMocks.createCollection.mockResolvedValue({ id: 'c-new', name: 'First' })
    const { onCatalogMutation } = renderLibrary([])

    await user.click(screen.getByRole('button', { name: '新建 Collection' }))
    const dialog = screen.getByRole('dialog', { name: '新建 Collection' })
    await user.type(within(dialog).getByLabelText('Collection 名称'), 'First')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() => expect(apiMocks.createCollection).toHaveBeenCalledWith({ name: 'First', description: undefined }))
    expect(onCatalogMutation).toHaveBeenCalledOnce()
  })

  it('creates a collection from the sidebar + button', async () => {
    const user = userEvent.setup()
    apiMocks.createCollection.mockResolvedValue({ id: 'c-3', name: 'Billing' })
    renderLibrary(twoCollections)

    await user.click(screen.getByRole('button', { name: 'New collection' }))
    const dialog = screen.getByRole('dialog', { name: '新建 Collection' })
    await user.type(within(dialog).getByLabelText('Collection 名称'), 'Billing')
    await user.type(within(dialog).getByLabelText('Collection 描述'), 'Money')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() => expect(apiMocks.createCollection).toHaveBeenCalledWith({ name: 'Billing', description: 'Money' }))
  })

  it('rejects an empty collection name', async () => {
    const user = userEvent.setup()
    renderLibrary(twoCollections)

    await user.click(screen.getByRole('button', { name: 'New collection' }))
    const dialog = screen.getByRole('dialog', { name: '新建 Collection' })
    await user.type(within(dialog).getByLabelText('Collection 名称'), '   ')
    // Submit stays disabled for whitespace-only names.
    expect(within(dialog).getByRole('button', { name: '创建' })).toHaveProperty('disabled', true)
    expect(apiMocks.createCollection).not.toHaveBeenCalled()
  })

  it('prefills the current name when renaming', async () => {
    const user = userEvent.setup()
    apiMocks.updateCollection.mockResolvedValue({ id: 'c-1', name: 'Auth v2' })
    renderLibrary(twoCollections)

    await user.click(screen.getByRole('button', { name: 'Collection 操作：Auth' }))
    await user.click(screen.getByRole('menuitem', { name: /重命名/ }))
    const dialog = screen.getByRole('dialog', { name: '重命名 Collection' })
    const nameInput = within(dialog).getByLabelText('Collection 名称') as HTMLInputElement
    expect(nameInput.value).toBe('Auth')
    await user.clear(nameInput)
    await user.type(nameInput, 'Auth v2')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(apiMocks.updateCollection).toHaveBeenCalledWith('c-1', { name: 'Auth v2', description: undefined }))
  })

  it('confirms before archiving a collection and archives through the mutation', async () => {
    const user = userEvent.setup()
    apiMocks.archiveCollection.mockResolvedValue(undefined)
    const { onCatalogMutation } = renderLibrary(twoCollections)

    await user.click(screen.getByRole('button', { name: 'Collection 操作：Auth' }))
    await user.click(screen.getByRole('menuitem', { name: /归档/ }))
    const dialog = screen.getByRole('alertdialog', { name: '确认归档 Collection' })
    expect(within(dialog).getByText(/从接口库中移除/)).toBeTruthy()
    expect(apiMocks.archiveCollection).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '归档' }))

    await waitFor(() => expect(apiMocks.archiveCollection).toHaveBeenCalledWith('c-1'))
    expect(onCatalogMutation).toHaveBeenCalledOnce()
  })

  it('surfaces a server error inside the collection form', async () => {
    const user = userEvent.setup()
    apiMocks.createCollection.mockRejectedValue(new Error('name already exists'))
    renderLibrary(twoCollections)

    await user.click(screen.getByRole('button', { name: 'New collection' }))
    const dialog = screen.getByRole('dialog', { name: '新建 Collection' })
    await user.type(within(dialog).getByLabelText('Collection 名称'), 'Auth')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    expect(await within(dialog).findByText('name already exists')).toBeTruthy()
  })

  it('disables collection writes in preview (fixture) mode', () => {
    renderLibrary(twoCollections, { isPreview: true })
    expect(screen.getByRole('button', { name: 'New collection' })).toHaveProperty('disabled', true)
    // No per-collection operations menu is offered in preview mode.
    expect(screen.queryByRole('button', { name: 'Collection 操作：Auth' })).toBeNull()
  })
})
