// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiCollectionGroup } from '../../data/api-catalog'
import { ApiLibrary } from './api-library'

const apiMocks = vi.hoisted(() => ({
  archiveRequest: vi.fn(),
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
