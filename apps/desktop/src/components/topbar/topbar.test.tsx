// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Topbar } from './topbar'
import { useRuntimeStatusStore } from '../../store/runtime-status-store'
import { useSessionStore } from '../../store/session-store'

afterEach(cleanup)

beforeEach(() => {
  useRuntimeStatusStore.setState({ httpStatus: 'online', lastCheckedAt: Date.now() })
  useSessionStore.setState({ wsStatus: 'connected' })
})

function renderTopbar(session: Parameters<typeof Topbar>[0]['session']) {
  return render(
    <Topbar
      session={session}
      onReview={vi.fn()}
      onStop={vi.fn()}
      onSearch={vi.fn()}
      onLibrary={vi.fn()}
      onRunHistory={vi.fn()}
      onRetryRuntime={vi.fn()}
    />,
  )
}

describe('Topbar with no session', () => {
  it('still shows the library, search, run history and runtime status entries', () => {
    renderTopbar(null)

    expect(screen.getByRole('button', { name: '打开接口库' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '搜索接口' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开运行历史' })).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Runtime 在线' })).toBeTruthy()
    // Session-only actions stay hidden.
    expect(screen.queryByRole('button', { name: /Review/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull()
  })

  it('shows an offline runtime indicator with a retry action', async () => {
    const user = userEvent.setup()
    const onRetryRuntime = vi.fn()
    useRuntimeStatusStore.setState({ httpStatus: 'offline' })
    useSessionStore.setState({ wsStatus: 'disconnected' })

    render(
      <Topbar
        session={null}
        onReview={vi.fn()}
        onStop={vi.fn()}
        onSearch={vi.fn()}
        onLibrary={vi.fn()}
        onRunHistory={vi.fn()}
        onRetryRuntime={onRetryRuntime}
      />,
    )

    expect(screen.getByRole('status', { name: 'Runtime 离线' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重试连接 Runtime' }))
    expect(onRetryRuntime).toHaveBeenCalledOnce()
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
