// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../../store/session-store'
import { ManualForm } from './manual-form'

afterEach(cleanup)

beforeEach(() => {
  useSessionStore.setState({
    sessions: [{
      id: 'session-1',
      type: 'manual',
      name: 'API test',
      status: 'idle',
      startedAt: 1,
      steps: [{ id: 'step-1', type: 'manual-input', status: 'pending' }],
    }],
    activeSessionId: 'session-1',
  })
})

describe('manual API save control', () => {
  it('uses one button to communicate draft state and the formal-save action', () => {
    const { container } = render(<ManualForm sessionId="session-1" stepId="step-1" />)

    expect(screen.getByRole('button', { name: 'Draft · Save API' })).toBeTruthy()
    expect(container.querySelector('.mr-save-state')).toBeNull()
    expect(screen.queryByText('Unsaved')).toBeNull()
  })
})
