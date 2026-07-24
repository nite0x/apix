// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './sidebar'
import { useRuleStore } from '../../store/rule-store'
import { useSessionStore } from '../../store/session-store'

afterEach(cleanup)

beforeEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useRuleStore.setState({ rules: [], savedRules: [], loadState: 'idle', saveState: 'idle', error: null })
})

function renderSidebar() {
  render(<Sidebar onNewFlow={vi.fn()} onOpenRules={vi.fn()} onOpenVariables={vi.fn()} onOpenRunHistory={vi.fn()} />)
}

describe('Sidebar', () => {
  it('shows a Run history entry', () => {
    renderSidebar()
    expect(screen.getByRole('button', { name: /Run history/ })).toBeTruthy()
  })

  it('shows the real rule count from the store, not a hardcoded 2', () => {
    useRuleStore.setState({
      rules: [
        { id: 'a', name: 'A', enabled: true, trigger: 'before', match: { method: 'GET' }, action: 'pause' },
        { id: 'b', name: 'B', enabled: true, trigger: 'before', match: { method: 'POST' }, action: 'pause' },
        { id: 'c', name: 'C', enabled: true, trigger: 'before', match: { method: 'PUT' }, action: 'pause' },
      ],
    })
    renderSidebar()
    const rulesButton = screen.getByRole('button', { name: /Pause rules/ })
    expect(rulesButton.textContent).toContain('3')
  })

  it('hides the count when there are no rules', () => {
    renderSidebar()
    const rulesButton = screen.getByRole('button', { name: /Pause rules/ })
    expect(rulesButton.textContent).not.toContain('2')
  })

  it('marks only the selected session as the current page', () => {
    useSessionStore.setState({
      activeSessionId: 'active',
      sessions: [
        { id: 'active', type: 'manual', name: 'Active flow', status: 'draft', startedAt: 1, steps: [] },
        { id: 'recent', type: 'manual', name: 'Recent flow', status: 'idle', startedAt: 2, steps: [] },
      ],
    })

    renderSidebar()
    expect(screen.getByRole('button', { name: /Active flow/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: /Recent flow/ }).getAttribute('aria-current')).toBeNull()
  })
})
