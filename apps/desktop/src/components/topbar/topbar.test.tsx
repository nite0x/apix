// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('Topbar with a Scratch session', () => {
  it('keeps Scratch identity while multiple requests are being edited', () => {
    renderTopbar({
      id: 'scratch-1',
      type: 'manual',
      name: 'Scratch',
      status: 'idle',
      startedAt: Date.now(),
      steps: [
        { id: 'r-1', type: 'manual-input', status: 'done' },
        { id: 'r-2', type: 'manual-input', status: 'pending' },
      ],
    })

    expect(screen.getByText('Scratch')).toBeTruthy()
    expect(screen.getByText('2 requests')).toBeTruthy()
    expect(screen.getByText('Scratch session')).toBeTruthy()
    expect(screen.queryByText(/Step 1 of 2/)).toBeNull()
  })

  it('offers Save as Flow for a Scratch session', async () => {
    const onSaveAsFlow = vi.fn()
    const onClearScratch = vi.fn()
    render(
      <Topbar
        session={{
          id: 'scratch-1',
          type: 'manual',
          name: 'Scratch',
          status: 'draft',
          startedAt: Date.now(),
          steps: [{ id: 'r-1', type: 'manual-input', status: 'pending' }],
        }}
        onReview={vi.fn()}
        onStop={vi.fn()}
        onSearch={vi.fn()}
        onLibrary={vi.fn()}
        onRunHistory={vi.fn()}
        onSaveAsFlow={onSaveAsFlow}
        onClearScratch={onClearScratch}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save as Flow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onSaveAsFlow).toHaveBeenCalledOnce()
    expect(onClearScratch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear' }))
    expect(onClearScratch).toHaveBeenCalledOnce()
  })

  it('can cancel clearing Scratch', () => {
    const onClearScratch = vi.fn()
    render(
      <Topbar
        session={{
          id: 'scratch-1',
          type: 'manual',
          name: 'Scratch',
          status: 'draft',
          startedAt: Date.now(),
          steps: [{ id: 'r-1', type: 'manual-input', status: 'pending' }],
        }}
        onReview={vi.fn()}
        onStop={vi.fn()}
        onSearch={vi.fn()}
        onLibrary={vi.fn()}
        onRunHistory={vi.fn()}
        onClearScratch={onClearScratch}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClearScratch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
  })
})
