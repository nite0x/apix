// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('keeps the complete request data for Save as Flow conversion', () => {
    vi.useFakeTimers()
    render(<ManualForm sessionId="session-1" stepId="step-1" />)

    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: 'https://api.example.com/orders' },
    })
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }))
    fireEvent.click(screen.getByRole('button', { name: '添加 Header' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Header key 1' }), {
      target: { value: 'Authorization' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Header value 1' }), {
      target: { value: 'Bearer token' },
    })

    const request = useSessionStore.getState().sessions[0].steps[0].requestData
    expect(request?.url).toBe('https://api.example.com/orders')
    expect(request?.headers).toEqual([
      { name: 'Authorization', value: 'Bearer token', enabled: true },
    ])
    vi.clearAllTimers()
    vi.useRealTimers()
  })
})
