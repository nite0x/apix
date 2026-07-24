import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRule } from '../services/api-client'
import {
  createRuleId,
  isValidStatusRange,
  rulesAreDirty,
  rulesForRequest,
  useRuleStore,
  validateRule,
} from './rule-store'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const serverRules: RuntimeRule[] = [
  { id: 'r-delete', name: 'Pause before DELETE', enabled: true, trigger: 'before', match: { method: 'DELETE' }, action: 'pause' },
]

beforeEach(() => {
  useRuleStore.setState({
    rules: [],
    savedRules: [],
    loadState: 'idle',
    saveState: 'idle',
    error: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rule validation', () => {
  it('requires a name', () => {
    expect(validateRule({ id: 'x', name: '  ', enabled: true, trigger: 'before', match: { method: 'GET' }, action: 'pause' }))
      .toMatch(/名称/)
  })

  it('requires at least one match condition for before rules', () => {
    expect(validateRule({ id: 'x', name: 'n', enabled: true, trigger: 'before', match: {}, action: 'pause' }))
      .toMatch(/匹配条件/)
  })

  it('requires a valid status range for after rules', () => {
    expect(validateRule({ id: 'x', name: 'n', enabled: true, trigger: 'after', match: {}, action: 'pause' })).toMatch(/状态码/)
    expect(validateRule({ id: 'x', name: 'n', enabled: true, trigger: 'after', match: { status_range: 'abc' }, action: 'pause' })).toMatch(/格式/)
    expect(validateRule({ id: 'x', name: 'n', enabled: true, trigger: 'after', match: { status_range: '400-499' }, action: 'pause' })).toBeNull()
  })

  it('accepts 3-digit codes, ranges and class shorthands', () => {
    expect(isValidStatusRange('404')).toBe(true)
    expect(isValidStatusRange('400-499')).toBe(true)
    expect(isValidStatusRange('4xx')).toBe(true)
    expect(isValidStatusRange('499-400')).toBe(false)
    expect(isValidStatusRange('40')).toBe(false)
  })
})

describe('createRuleId', () => {
  it('produces unique ids with a fallback', () => {
    const original = globalThis.crypto
    // Simulate an environment without randomUUID.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    const a = createRuleId()
    const b = createRuleId()
    expect(a).not.toBe(b)
    expect(a.startsWith('rule-')).toBe(true)
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
  })
})

describe('rule store lifecycle', () => {
  it('maps GET rules into draft + saved snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(serverRules)))
    await useRuleStore.getState().loadRules()
    const state = useRuleStore.getState()
    expect(state.loadState).toBe('ready')
    expect(state.rules).toHaveLength(1)
    expect(rulesAreDirty(state.rules, state.savedRules)).toBe(false)
  })

  it('reports empty when no rules exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])))
    await useRuleStore.getState().loadRules()
    expect(useRuleStore.getState().loadState).toBe('empty')
  })

  it('supports create/update/toggle/delete draft edits', async () => {
    const id = useRuleStore.getState().createRule('before')
    expect(useRuleStore.getState().rules).toHaveLength(1)
    useRuleStore.getState().updateRule(id, { name: 'My rule' })
    useRuleStore.getState().updateRuleMatch(id, { method: 'POST' })
    expect(useRuleStore.getState().rules[0]).toMatchObject({ name: 'My rule', match: { method: 'POST' } })
    useRuleStore.getState().toggleRule(id)
    expect(useRuleStore.getState().rules[0].enabled).toBe(false)
    useRuleStore.getState().deleteRule(id)
    expect(useRuleStore.getState().rules).toHaveLength(0)
  })

  it('PUTs the complete draft array and marks it saved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const id = useRuleStore.getState().createRule('before')
    useRuleStore.getState().updateRule(id, { name: 'Pause POST' })
    useRuleStore.getState().updateRuleMatch(id, { method: 'POST' })

    const ok = await useRuleStore.getState().saveRules()

    expect(ok).toBe(true)
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string) as RuntimeRule[]
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ name: 'Pause POST', match: { method: 'POST' } })
    const state = useRuleStore.getState()
    expect(state.saveState).toBe('saved')
    expect(rulesAreDirty(state.rules, state.savedRules)).toBe(false)
  })

  it('blocks saving an invalid rule with an error', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    useRuleStore.getState().createRule('before') // blank name + empty match
    const ok = await useRuleStore.getState().saveRules()
    expect(ok).toBe(false)
    expect(useRuleStore.getState().saveState).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the draft when a save fails on the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)))
    const id = useRuleStore.getState().createRule('before')
    useRuleStore.getState().updateRule(id, { name: 'Keep me' })
    useRuleStore.getState().updateRuleMatch(id, { method: 'GET' })

    const ok = await useRuleStore.getState().saveRules()

    expect(ok).toBe(false)
    const state = useRuleStore.getState()
    expect(state.saveState).toBe('error')
    // Draft survives so nothing the user typed is lost.
    expect(state.rules[0].name).toBe('Keep me')
    expect(rulesAreDirty(state.rules, state.savedRules)).toBe(true)
  })

  it('reset discards unsaved draft edits back to the saved snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(serverRules)))
    await useRuleStore.getState().loadRules()
    useRuleStore.getState().updateRule('r-delete', { name: 'Changed' })
    expect(rulesAreDirty(useRuleStore.getState().rules, useRuleStore.getState().savedRules)).toBe(true)

    useRuleStore.getState().reset()

    expect(useRuleStore.getState().rules[0].name).toBe('Pause before DELETE')
    expect(rulesAreDirty(useRuleStore.getState().rules, useRuleStore.getState().savedRules)).toBe(false)
  })

  it('reload discards unsaved edits by refetching from the runtime', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(serverRules))))
    await useRuleStore.getState().loadRules()
    useRuleStore.getState().updateRule('r-delete', { name: 'Local only' })

    await useRuleStore.getState().reload()

    expect(useRuleStore.getState().rules[0].name).toBe('Pause before DELETE')
  })
})

describe('rulesForRequest', () => {
  const rules: RuntimeRule[] = [
    { id: 'a', name: 'DELETE', enabled: true, trigger: 'before', match: { method: 'DELETE' }, action: 'pause' },
    { id: 'b', name: 'users', enabled: true, trigger: 'before', match: { url_pattern: '*/users*' }, action: 'pause' },
    { id: 'c', name: 'after', enabled: true, trigger: 'after', match: { status_range: '4xx' }, action: 'pause' },
  ]

  it('matches by method and url pattern, and always includes after rules', () => {
    const result = rulesForRequest(rules, 'GET', 'https://api.example.com/users')
    const ids = result.map((rule) => rule.id)
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(ids).not.toContain('a')
  })
})
