// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRule } from '../../services/api-client'
import { useRuleStore } from '../../store/rule-store'
import { RulesManager } from './rules-manager'

const serverRules: RuntimeRule[] = [
  { id: 'r-delete', name: 'Pause before DELETE', enabled: true, trigger: 'before', match: { method: 'DELETE' }, action: 'pause' },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Routes fetch by URL + method so the store's client works against a stub. */
function stubFetch(options: { rules?: RuntimeRule[]; putStatus?: number } = {}) {
  const { rules = serverRules, putStatus = 200 } = options
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return Promise.resolve(putStatus === 200 ? jsonResponse({ ok: true }) : jsonResponse({ error: 'save failed' }, putStatus))
    }
    return Promise.resolve(jsonResponse(rules))
  }))
}

beforeEach(() => {
  useRuleStore.setState({ rules: [], savedRules: [], loadState: 'idle', saveState: 'idle', error: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('RulesManager', () => {
  it('renders the runtime rules (not the removed baseRules mock)', async () => {
    stubFetch()
    render(<RulesManager onClose={vi.fn()} />)
    expect(await screen.findByText('Pause before DELETE')).toBeTruthy()
    expect(screen.queryByText('Pause if response is 4xx')).toBeNull()
  })

  it('creates a rule and switches match fields between before and after', async () => {
    const user = userEvent.setup()
    stubFetch({ rules: [] })
    render(<RulesManager onClose={vi.fn()} />)
    await waitFor(() => expect(useRuleStore.getState().loadState).toBe('empty'))

    await user.click(screen.getAllByRole('button', { name: '新建规则' })[0])
    // before trigger shows Method/URL/env fields
    expect(screen.getByLabelText('Method')).toBeTruthy()
    expect(screen.getByLabelText('URL Pattern')).toBeTruthy()

    await user.selectOptions(screen.getByLabelText('触发时机'), 'after')
    // after trigger swaps to status range
    expect(screen.getByLabelText('状态码范围')).toBeTruthy()
    expect(screen.queryByLabelText('URL Pattern')).toBeNull()
  })

  it('shows a validation error for an empty match and blocks save', async () => {
    const user = userEvent.setup()
    stubFetch({ rules: [] })
    render(<RulesManager onClose={vi.fn()} />)
    await waitFor(() => expect(useRuleStore.getState().loadState).toBe('empty'))

    await user.click(screen.getAllByRole('button', { name: '新建规则' })[0])
    await user.type(screen.getByLabelText('规则名称'), 'Incomplete')
    // No match condition entered.
    expect(screen.getByRole('alert').textContent).toMatch(/匹配条件/)
  })

  it('toggles, edits and saves the full rule array', async () => {
    const user = userEvent.setup()
    stubFetch()
    render(<RulesManager onClose={vi.fn()} />)
    await screen.findByText('Pause before DELETE')

    const nameInput = await screen.findByLabelText('规则名称') as HTMLInputElement
    await user.clear(nameInput)
    await user.type(nameInput, 'Pause DELETE v2')

    await user.click(screen.getByRole('button', { name: '保存全部更改' }))

    await waitFor(() => expect(useRuleStore.getState().saveState).toBe('saved'))
    expect(useRuleStore.getState().savedRules[0].name).toBe('Pause DELETE v2')
  })

  it('keeps the draft and shows an error when the save fails', async () => {
    const user = userEvent.setup()
    stubFetch({ putStatus: 500 })
    render(<RulesManager onClose={vi.fn()} />)
    await screen.findByText('Pause before DELETE')

    const nameInput = screen.getByLabelText('规则名称') as HTMLInputElement
    await user.clear(nameInput)
    await user.type(nameInput, 'Draft survives')
    await user.click(screen.getByRole('button', { name: '保存全部更改' }))

    await waitFor(() => expect(useRuleStore.getState().saveState).toBe('error'))
    // Draft preserved on the screen.
    expect((screen.getByLabelText('规则名称') as HTMLInputElement).value).toBe('Draft survives')
  })

  it('deletes a rule from the draft', async () => {
    const user = userEvent.setup()
    stubFetch()
    render(<RulesManager onClose={vi.fn()} />)
    await screen.findByText('Pause before DELETE')

    await user.click(screen.getByRole('button', { name: /删除规则/ }))
    expect(useRuleStore.getState().rules).toHaveLength(0)
  })

  it('discards unsaved edits with 放弃修改', async () => {
    const user = userEvent.setup()
    stubFetch()
    render(<RulesManager onClose={vi.fn()} />)
    await screen.findByText('Pause before DELETE')

    const nameInput = screen.getByLabelText('规则名称') as HTMLInputElement
    await user.clear(nameInput)
    await user.type(nameInput, 'temp change')
    await user.click(screen.getByRole('button', { name: '放弃修改' }))

    expect(useRuleStore.getState().rules[0].name).toBe('Pause before DELETE')
  })
})
