// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StepCard } from './step-card'

afterEach(cleanup)

describe('manual API test card', () => {
  it('offers a direct delete action without toggling the card', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()

    render(
      <StepCard
        sessionId="session-1"
        step={{ id: 'step-1', type: 'manual-input', status: 'done', method: 'POST', url: 'https://example.com' }}
        onDelete={onDelete}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Delete request step' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.queryByText('Headers (one Name: Value per line)')).toBeNull()
  })

  it('keeps the direct delete action available for newly configured cards', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()

    render(
      <StepCard
        sessionId="session-1"
        step={{ id: 'step-1', type: 'manual-input', status: 'running' }}
        onDelete={onDelete}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Delete request step' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
