import { create } from 'zustand'
import type { RequestData } from '../data/api-catalog'

export type SessionStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped' | 'idle' | 'draft'
export type SessionType = 'ai' | 'manual'
export type StepStatus = 'pending' | 'running' | 'paused' | 'done' | 'error' | 'skipped'
export type StepType = 'think' | 'http' | 'manual-input' | 'sql'

export interface ExtractedVar {
  name: string
  scope: string
  source?: string
  valuePreview?: string
  direction?: 'in' | 'out'
}

export interface MatchedRule {
  id: string
  name: string
  description: string
  enabled?: boolean
}

export interface Step {
  id: string
  type: StepType
  status: StepStatus
  method?: string
  url?: string
  statusCode?: number
  durationMs?: number
  requestBody?: string
  responseBody?: string
  extractedVars?: ExtractedVar[]
  resolvedVars?: ExtractedVar[]
  text?: string
  ruleId?: string
  ruleName?: string
  riskSummary?: string
  dataScope?: string
  apiRequestId?: string
  requestData?: RequestData
}

export interface Session {
  id: string
  type: SessionType
  name: string
  status: SessionStatus
  startedAt: number
  steps: Step[]
  source?: string
  task?: string
  environment?: string
  summary?: string
  currentStep?: number
  totalSteps?: number
  elapsedMs?: number
  variables?: ExtractedVar[]
  matchedRule?: MatchedRule
}

export interface BackendStep {
  id: string
  type: 'request' | 'think' | 'manual'
  status: 'pending' | 'running' | 'done' | 'error' | 'paused' | 'skipped'
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  thought?: string
  error?: string
  rule_id?: string
  duration_ms?: number
}

export interface BackendSession {
  id: string
  type: 'ai' | 'manual'
  status: 'running' | 'paused' | 'done' | 'error' | 'stopped'
  task?: string
  source?: string
  steps?: BackendStep[]
  variables?: {
    global?: Record<string, { name?: string; scope?: string; source?: string }>
    session?: Record<string, { name?: string; scope?: string; source?: string }>
  }
  created_at?: string
}

interface AppStore {
  sessions: Session[]
  activeSessionId: string | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  setActiveSession: (id: string | null) => void
  setSessions: (sessions: Session[]) => void
  addSession: (session: Session) => void
  updateSession: (id: string, patch: Partial<Session>) => void
  addStep: (sessionId: string, step: Step) => void
  updateStep: (sessionId: string, stepId: string, patch: Partial<Step>) => void
  removeStep: (sessionId: string, stepId: string) => void
  loadSessions: () => Promise<void>
  startScratchSession: () => string
  resetScratchSession: (id: string) => void
  appendManualStep: (sessionId: string, request?: { method?: string; url?: string; apiRequestId?: string }) => string
  configureManualStep: (sessionId: string, stepId: string, request: { method?: string; url?: string; apiRequestId?: string }) => void
  resolvePausedStep: (sessionId: string, stepId: string, action: 'continue' | 'skip' | 'stop') => void
  wsStatus: 'connected' | 'disconnected'
  setWsStatus: (status: 'connected' | 'disconnected') => void
}

const API_BASE_URL = 'http://127.0.0.1:4317'

function mapStepStatus(status: BackendStep['status']): StepStatus {
  if (status === 'done' || status === 'error' || status === 'skipped' || status === 'paused' || status === 'pending') {
    return status
  }
  return 'running'
}

function mapSessionStatus(status: BackendSession['status']): SessionStatus {
  if (status === 'paused') return 'paused'
  if (status === 'done') return 'done'
  if (status === 'error' || status === 'stopped') return 'failed'
  return 'running'
}

function mapBackendVariables(session: BackendSession): ExtractedVar[] | undefined {
  const values = [
    ...Object.values(session.variables?.global ?? {}),
    ...Object.values(session.variables?.session ?? {}),
  ]
  if (values.length === 0) return undefined
  return values.map((variable) => ({
    name: variable.name ?? 'variable',
    scope: variable.scope ?? 'session',
    source: variable.source,
    valuePreview: '••••••••••••',
  }))
}

export function mapBackendStep(step: BackendStep): Step {
  const input = step.input ?? {}
  const output = step.output ?? {}
  const rawBody = output.body

  return {
    id: step.id,
    type: step.type === 'request' ? 'http' : step.type === 'manual' ? 'manual-input' : 'think',
    status: mapStepStatus(step.status),
    method: typeof input.method === 'string' ? input.method : undefined,
    url: typeof input.url === 'string' ? input.url : undefined,
    requestBody: typeof input.body === 'string' ? input.body : undefined,
    statusCode: typeof output.status === 'number' ? output.status : undefined,
    durationMs:
      typeof output.duration === 'number'
        ? output.duration
        : typeof step.duration_ms === 'number'
          ? step.duration_ms
          : undefined,
    responseBody:
      typeof rawBody === 'string'
        ? rawBody
        : rawBody != null
          ? JSON.stringify(rawBody, null, 2)
          : step.error,
    text: step.thought,
    ruleId: step.rule_id,
    ruleName: step.rule_id ? `Matched rule ${step.rule_id}` : undefined,
  }
}

export function mapBackendSession(session: BackendSession): Session {
  const startedAt = session.created_at ? Date.parse(session.created_at) : Number.NaN
  return {
    id: session.id,
    type: session.type === 'manual' ? 'manual' : 'ai',
    name: session.task || 'Untitled session',
    status: mapSessionStatus(session.status),
    startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
    steps: (session.steps ?? []).map(mapBackendStep),
    source: session.source,
    task: session.task,
    variables: mapBackendVariables(session),
  }
}

export const useSessionStore = create<AppStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loadState: 'idle',
  wsStatus: 'disconnected',

  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  setSessions: (sessions) =>
    set((state) => {
      // Backend execution sessions may finish loading after a local Scratch was
      // opened. Preserve that singleton instead of replacing it on hydration.
      const scratch = state.sessions.find((session) => session.type === 'manual' && session.source === 'scratch')
      const merged = scratch && !sessions.some((session) => session.id === scratch.id)
        ? [scratch, ...sessions]
        : sessions
      return {
        sessions: merged,
        activeSessionId:
          state.activeSessionId && merged.some((session) => session.id === state.activeSessionId)
            ? state.activeSessionId
            : merged[0]?.id ?? null,
      }
    }),

  addSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
      activeSessionId: state.activeSessionId ?? session.id,
    })),

  updateSession: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)),
    })),

  addStep: (sessionId, step) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              steps: session.steps.some((item) => item.id === step.id)
                ? session.steps
                : [...session.steps, step],
            }
          : session,
      ),
    })),

  updateStep: (sessionId, stepId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              steps: session.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
            }
          : session,
      ),
    })),

  removeStep: (sessionId, stepId) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId || !session.steps.some((step) => step.id === stepId)) return session

        const steps = session.steps.filter((step) => step.id !== stepId)
        const totalSteps = Math.max(0, (session.totalSteps ?? session.steps.length) - 1)
        return {
          ...session,
          steps,
          totalSteps,
          currentStep: session.currentStep == null ? undefined : Math.min(session.currentStep, totalSteps),
          status: steps.length === 0 ? 'idle' : session.status,
        }
      }),
    })),

  loadSessions: async () => {
    set({ loadState: 'loading' })
    try {
      const response = await fetch(`${API_BASE_URL}/api/sessions`)
      if (!response.ok) {
        throw new Error(`Failed to load sessions: ${response.status}`)
      }
      const sessions = (await response.json()) as BackendSession[]
      get().setSessions(sessions.map(mapBackendSession))
      set({ loadState: 'ready' })
    } catch {
      set({ loadState: 'error' })
    }
  },

  startScratchSession: () => {
    const existing = get().sessions.find((session) => session.type === 'manual' && session.source === 'scratch')
    if (existing) {
      set({ activeSessionId: existing.id })
      return existing.id
    }
    const id = `scratch-${Date.now()}`
    const stepId = `${id}-input`
    set((state) => ({
      activeSessionId: id,
      sessions: [{
        id,
        type: 'manual',
        name: 'Scratch',
        status: 'draft',
        startedAt: Date.now(),
        source: 'scratch',
        environment: 'Production',
        currentStep: 1,
        totalSteps: 1,
        steps: [{ id: stepId, type: 'manual-input', status: 'pending' }],
      }, ...state.sessions],
    }))
    return id
  },

  resetScratchSession: (id) => {
    const stepId = `${id}-input-${Date.now()}`
    set((state) => ({
      activeSessionId: id,
      sessions: state.sessions.map((session) => session.id === id ? {
        ...session,
        name: 'Scratch',
        status: 'draft',
        currentStep: 1,
        totalSteps: 1,
        summary: undefined,
        variables: undefined,
        matchedRule: undefined,
        steps: [{ id: stepId, type: 'manual-input', status: 'pending' }],
      } : session),
    }))
  },

  appendManualStep: (sessionId, request = {}) => {
    const stepId = `${sessionId}-manual-${Date.now()}`
    set((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId ? {
        ...session,
        status: session.status === 'paused' || session.status === 'draft' ? session.status : 'idle',
        totalSteps: (session.totalSteps ?? session.steps.length) + 1,
        steps: [...session.steps, {
          id: stepId,
          type: 'manual-input',
          status: 'pending',
          method: request.method,
          url: request.url,
          apiRequestId: request.apiRequestId,
        }],
      } : session),
    }))
    return stepId
  },

  configureManualStep: (sessionId, stepId, request) =>
    set((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId ? {
        ...session,
        name: request.url ? `${request.method ?? 'GET'} ${request.url}` : session.name,
        status: 'idle',
        steps: session.steps.map((step) => step.id === stepId ? {
          ...step,
          status: 'running',
          method: request.method ?? step.method ?? 'GET',
          url: request.url ?? step.url,
          apiRequestId: request.apiRequestId ?? step.apiRequestId,
        } : step),
      } : session),
    })),

  resolvePausedStep: (sessionId, stepId, action) =>
    set((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId ? {
        ...session,
        status: action === 'stop' ? 'stopped' : 'running',
        matchedRule: action === 'continue' ? undefined : session.matchedRule,
        steps: session.steps.map((step) => step.id === stepId ? {
          ...step,
          status: action === 'skip' ? 'skipped' : action === 'stop' ? 'error' : 'running',
        } : step),
      } : session),
    })),

  setWsStatus: (wsStatus) => set({ wsStatus }),
}))
