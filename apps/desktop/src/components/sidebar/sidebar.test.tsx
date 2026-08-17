// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './sidebar'
import { useRuleStore } from '../../store/rule-store'
import { useSessionStore } from '../../store/session-store'
import { useFlowStore } from '../../store/flow-store'

afterEach(cleanup)

beforeEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useRuleStore.setState({ rules: [], savedRules: [], loadState: 'idle', saveState: 'idle', error: null })
  useFlowStore.setState({ summaries: [], selectedFlowId: null })
})

function renderSidebar() {
  render(
    <Sidebar
      onNewRequest={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenFlow={vi.fn()}
      onRenameFlow={vi.fn()}
      onDeleteFlow={vi.fn()}
      onOpenRules={vi.fn()}
      onOpenVariables={vi.fn()}
      onOpenRunHistory={vi.fn()}
    />,
  )
}

describe('Sidebar', () => {
  it('shows a Request history entry', () => {
    renderSidebar()
    expect(screen.getByRole('button', { name: /Request history/ })).toBeTruthy()
  })

  it('uses one New request action to create Flow documents', () => {
    renderSidebar()

    expect(screen.getByRole('button', { name: 'New request' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'New request' })).toHaveLength(1)
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
        { id: 'active', type: 'ai', name: 'Active run', status: 'running', startedAt: 1, steps: [] },
        { id: 'recent', type: 'ai', name: 'Recent run', status: 'idle', startedAt: 2, steps: [] },
      ],
    })

    renderSidebar()
    expect(screen.getByRole('button', { name: /Active run/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: /Recent run/ }).getAttribute('aria-current')).toBeNull()
  })

  it('lists backend manual sessions alongside other execution sessions', () => {
    useSessionStore.setState({
      activeSessionId: 'manual-1',
      sessions: [{
        id: 'manual-1',
        type: 'manual',
        name: 'Manual run',
        status: 'running',
        startedAt: 1,
        steps: [],
      }],
    })

    renderSidebar()
    expect(screen.getByRole('button', { name: /Manual run/ })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Live' })).toBeTruthy()
  })
})
