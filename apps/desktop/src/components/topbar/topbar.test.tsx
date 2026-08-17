// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Topbar } from './topbar'

afterEach(cleanup)

function renderTopbar(session: Parameters<typeof Topbar>[0]['session']) {
  return render(
    <Topbar
      session={session}
      onReview={vi.fn()}
      onStop={vi.fn()}
      onSearch={vi.fn()}
      onLibrary={vi.fn()}
      onRunHistory={vi.fn()}
    />,
  )
}

describe('Topbar with no session', () => {
  it('shows workspace commands without exposing runtime status', () => {
    renderTopbar(null)

    expect(screen.getByRole('button', { name: '打开接口库' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '搜索接口' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开请求历史' })).toBeTruthy()
    expect(screen.queryByText(/Runtime/)).toBeNull()
    // Session-only actions stay hidden.
    expect(screen.queryByRole('button', { name: /Review/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull()
  })
})

describe('Topbar with a paused session', () => {
  it('reveals Review and Stop actions', () => {
    renderTopbar({
      id: 's-1',
      type: 'manual',
      name: 'GET /users',
      status: 'paused',
      startedAt: Date.now(),
      steps: [],
    })

    expect(screen.getByRole('button', { name: /Review/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    // Core entries remain available too.
    expect(screen.getByRole('button', { name: '打开接口库' })).toBeTruthy()
  })
})

describe('Topbar with a manual execution session', () => {
  it('shows the backend session identity without document actions', () => {
    renderTopbar({
      id: 'manual-1',
      type: 'manual',
      name: 'Manual run',
      status: 'idle',
      startedAt: Date.now(),
      currentStep: 2,
      totalSteps: 2,
      steps: [
        { id: 'r-1', type: 'manual-input', status: 'done' },
        { id: 'r-2', type: 'manual-input', status: 'pending' },
      ],
    })

    expect(screen.getByText('Manual run')).toBeTruthy()
    expect(screen.getByText('Step 2 of 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
  })
})
