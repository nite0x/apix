// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPanel } from './session-panel'
import { useRuleStore } from '../../store/rule-store'
import type { Session } from '../../store/session-store'

const session: Session = {
  id: 's-1',
  type: 'manual',
  name: 'GET /users',
  status: 'running',
  startedAt: Date.now(),
  steps: [],
  matchedRule: { id: 'r-delete', name: 'Pause before DELETE', description: 'confirm' },
}

beforeEach(() => {
  useRuleStore.setState({
    rules: [
      { id: 'r-delete', name: 'Pause before DELETE', enabled: true, trigger: 'before', match: { method: 'DELETE' }, action: 'pause' },
    ],
    savedRules: [
      { id: 'r-delete', name: 'Pause before DELETE', enabled: true, trigger: 'before', match: { method: 'DELETE' }, action: 'pause' },
    ],
    loadState: 'ready',
    saveState: 'idle',
    error: null,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SessionPanel rules tab', () => {
  it('renders rules from the shared store, not hardcoded baseRules', async () => {
    const user = userEvent.setup()
    render(<SessionPanel session={session} activeTab="rules" onTabChange={vi.fn()} onManageRules={vi.fn()} />)

    expect(screen.getByText('Pause before DELETE')).toBeTruthy()
    // The removed baseRules mock rule must not appear.
    expect(screen.queryByText('Pause if response is 4xx')).toBeNull()

    // Toggling edits the shared draft (and surfaces an unsaved indicator).
    await user.click(screen.getByRole('switch', { name: 'Pause before DELETE' }))
    expect(useRuleStore.getState().rules[0].enabled).toBe(false)
    expect(screen.getByText(/尚未保存/)).toBeTruthy()
  })

  it('opens the rules manager from the panel', async () => {
    const user = userEvent.setup()
    const onManageRules = vi.fn()
    render(<SessionPanel session={session} activeTab="rules" onTabChange={vi.fn()} onManageRules={onManageRules} />)
    await user.click(screen.getByRole('button', { name: /管理规则/ }))
    expect(onManageRules).toHaveBeenCalledOnce()
  })
})

describe('SessionPanel Scratch tab', () => {
  it('describes a manual draft as Scratch instead of a Flow', () => {
    render(
      <SessionPanel
        session={{
          id: 'scratch-1',
          type: 'manual',
          name: 'Scratch',
          status: 'draft',
          startedAt: Date.now(),
          steps: [{ id: 'request-1', type: 'manual-input', status: 'pending' }],
        }}
        activeTab="session"
        onTabChange={vi.fn()}
        onManageRules={vi.fn()}
      />,
    )

    expect(screen.getByText('Scratch status')).toBeTruthy()
    expect(screen.getByText('1 request')).toBeTruthy()
    expect(screen.queryByText('Flow status')).toBeNull()
    expect(screen.queryByText('New flow')).toBeNull()
  })
})
