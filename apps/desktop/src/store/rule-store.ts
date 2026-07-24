import { create } from 'zustand'
import {
  CatalogError,
  getRules,
  updateRules,
  type RuleTrigger,
  type RuntimeRule,
} from '../services/api-client'

export type RuleLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type RuleSaveState = 'idle' | 'saving' | 'saved' | 'error'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/** Generates a rule id. Uses crypto.randomUUID when available, else a fallback. */
export function createRuleId(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `rule-${cryptoObj.randomUUID()}`
  }
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function blankRule(trigger: RuleTrigger = 'before'): RuntimeRule {
  return {
    id: createRuleId(),
    name: '',
    enabled: true,
    trigger,
    match: {},
    action: 'pause',
  }
}

/** Accepts a 3-digit code (404), a code range (400-499), or a class shorthand (4xx). */
export function isValidStatusRange(value: string): boolean {
  const trimmed = value.trim()
  if (/^[1-5]xx$/.test(trimmed)) return true
  if (/^\d{3}$/.test(trimmed)) return true
  const rangeMatch = /^(\d{3})-(\d{3})$/.exec(trimmed)
  if (rangeMatch) {
    return Number(rangeMatch[1]) <= Number(rangeMatch[2])
  }
  return false
}

/** Returns a validation error message for a rule, or null when it is valid. */
export function validateRule(rule: RuntimeRule): string | null {
  if (!rule.name.trim()) return '请填写规则名称'
  if (rule.trigger === 'before') {
    const hasMatch = Boolean(rule.match.method?.trim() || rule.match.url_pattern?.trim() || rule.match.env?.trim())
    if (!hasMatch) return '请至少填写一个匹配条件（Method / URL / 环境）'
  } else {
    const range = rule.match.status_range?.trim()
    if (!range) return '请填写状态码范围'
    if (!isValidStatusRange(range)) return '状态码范围格式不正确，例如 404 或 400-499'
  }
  return null
}

/** Validates every rule, returning the first error paired with the rule id. */
export function firstRuleError(rules: RuntimeRule[]): { id: string; message: string } | null {
  for (const rule of rules) {
    const message = validateRule(rule)
    if (message) return { id: rule.id, message }
  }
  return null
}

function cloneRules(rules: RuntimeRule[]): RuntimeRule[] {
  return rules.map((rule) => ({ ...rule, match: { ...rule.match } }))
}

/** True when the working draft differs from the last server-persisted state. */
export function rulesAreDirty(rules: RuntimeRule[], savedRules: RuntimeRule[]): boolean {
  return JSON.stringify(rules) !== JSON.stringify(savedRules)
}

export interface RuleStore {
  rules: RuntimeRule[]
  savedRules: RuntimeRule[]
  loadState: RuleLoadState
  saveState: RuleSaveState
  error: string | null
  loadRules: () => Promise<void>
  reload: () => Promise<void>
  reset: () => void
  saveRules: () => Promise<boolean>
  createRule: (trigger?: RuleTrigger) => string
  updateRule: (id: string, patch: Partial<RuntimeRule>) => void
  updateRuleMatch: (id: string, patch: Partial<RuntimeRule['match']>) => void
  deleteRule: (id: string) => void
  toggleRule: (id: string) => void
}

let loadSequence = 0

export const useRuleStore = create<RuleStore>((set, get) => ({
  rules: [],
  savedRules: [],
  loadState: 'idle',
  saveState: 'idle',
  error: null,

  loadRules: async () => {
    const sequence = ++loadSequence
    set({ loadState: 'loading', error: null })
    try {
      const rules = await getRules()
      if (sequence !== loadSequence) return
      set({
        rules: cloneRules(rules),
        savedRules: cloneRules(rules),
        loadState: rules.length === 0 ? 'empty' : 'ready',
        saveState: 'idle',
        error: null,
      })
    } catch (error) {
      if (sequence !== loadSequence) return
      const message = error instanceof CatalogError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to load rules'
      set({ loadState: 'error', error: message })
    }
  },

  reload: async () => {
    await get().loadRules()
  },

  reset: () => set((state) => ({ rules: cloneRules(state.savedRules), saveState: 'idle', error: null })),

  saveRules: async () => {
    const invalid = firstRuleError(get().rules)
    if (invalid) {
      set({ saveState: 'error', error: invalid.message })
      return false
    }
    set({ saveState: 'saving', error: null })
    try {
      const payload = cloneRules(get().rules)
      await updateRules(payload)
      // Keep the user's current draft as the authoritative saved snapshot.
      set({
        savedRules: cloneRules(payload),
        loadState: payload.length === 0 ? 'empty' : 'ready',
        saveState: 'saved',
        error: null,
      })
      return true
    } catch (error) {
      // Preserve the draft so nothing the user typed is lost on a failed save.
      const message = error instanceof Error ? error.message : 'Failed to save rules'
      set({ saveState: 'error', error: message })
      return false
    }
  },

  createRule: (trigger = 'before') => {
    const rule = blankRule(trigger)
    set((state) => ({ rules: [...state.rules, rule], saveState: 'idle' }))
    return rule.id
  },

  updateRule: (id, patch) =>
    set((state) => ({
      rules: state.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
      saveState: 'idle',
    })),

  updateRuleMatch: (id, patch) =>
    set((state) => ({
      rules: state.rules.map((rule) => (rule.id === id ? { ...rule, match: { ...rule.match, ...patch } } : rule)),
      saveState: 'idle',
    })),

  deleteRule: (id) =>
    set((state) => ({ rules: state.rules.filter((rule) => rule.id !== id), saveState: 'idle' })),

  toggleRule: (id) =>
    set((state) => ({
      rules: state.rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)),
      saveState: 'idle',
    })),
}))

/** Filters rules that could apply to a given method/url, for the API detail view. */
export function rulesForRequest(rules: RuntimeRule[], method: string, url: string): RuntimeRule[] {
  const upperMethod = method.toUpperCase()
  return rules.filter((rule) => {
    if (rule.trigger === 'after') return true
    const ruleMethod = rule.match.method?.trim().toUpperCase()
    if (ruleMethod && ruleMethod !== upperMethod) return false
    const pattern = rule.match.url_pattern?.trim()
    if (pattern) {
      // Lightweight glob: treat * as a wildcard so "*/users*" style patterns match.
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      try {
        if (!new RegExp(escaped).test(url)) return false
      } catch {
        return url.includes(pattern)
      }
    }
    return true
  })
}
