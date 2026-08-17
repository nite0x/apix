// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore, type Step } from '../../store/session-store'
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

  it('renders one persisted response after collapsing and reopening the card', async () => {
    const user = userEvent.setup()
    const step: Step = {
      id: 'step-response',
      type: 'manual-input',
      status: 'done',
      method: 'POST',
      url: 'https://example.com/posts',
      statusCode: 201,
      durationMs: 826,
      responseBody: '{ "id": 101 }',
    }
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        type: 'manual',
        name: 'Manual run',
        status: 'idle',
        startedAt: 1,
        steps: [step],
      }],
      activeSessionId: 'session-1',
    })

    const { container } = render(
      <StepCard sessionId="session-1" step={step} defaultOpen />,
    )

    expect(screen.getAllByText('Response')).toHaveLength(1)
    expect(screen.getByText('{ "id": 101 }')).toBeTruthy()

    const header = container.querySelector<HTMLElement>('.chead')
    expect(header).toBeTruthy()
    await user.click(header!)
    expect(screen.queryByText('Response')).toBeNull()

    await user.click(header!)
    expect(screen.getAllByText('Response')).toHaveLength(1)
    expect(screen.getByText('{ "id": 101 }')).toBeTruthy()
  })
})
