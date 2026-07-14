import { create } from 'zustand'

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

interface AppStore {
  sessions: Session[]
  activeSessionId: string | null
  setActiveSession: (id: string) => void
  addSession: (s: Session) => void
  updateSession: (id: string, patch: Partial<Session>) => void
  addStep: (sessionId: string, step: Step) => void
  updateStep: (sessionId: string, stepId: string, patch: Partial<Step>) => void
  startNewFlow: () => string
  appendManualStep: (sessionId: string, request?: { method?: string; url?: string; apiRequestId?: string }) => string
  configureManualStep: (sessionId: string, stepId: string, request: { method?: string; url?: string; apiRequestId?: string }) => void
  resolvePausedStep: (sessionId: string, stepId: string, action: 'continue' | 'skip' | 'stop') => void
  wsStatus: 'connected' | 'disconnected'
  setWsStatus: (s: 'connected' | 'disconnected') => void
}

const DEMO_SESSIONS: Session[] = [
  {
    id: 'ai1',
    type: 'ai',
    name: 'Login + fetch admins',
    status: 'paused',
    startedAt: Date.now() - 60000,
    source: 'claude-desktop',
    task: 'Login then get all admin users and summarise',
    environment: 'Production',
    currentStep: 3,
    totalSteps: 5,
    elapsedMs: 566,
    matchedRule: {
      id: 'r-prod-users',
      name: 'Pause before GET /users',
      description: 'Production user-list requests need manual confirmation.',
      enabled: true,
    },
    variables: [{ name: 'token', scope: 'global', source: 'POST /auth/login · .token', valuePreview: 'eyJhbGciOiJIUzI1NiJ9…', direction: 'out' }],
    steps: [
      { id: 's1', type: 'think', status: 'done', text: 'I need to POST /auth/login to get a bearer token, then use it on GET /users?role=admin.' },
      {
        id: 's2', type: 'http', status: 'done',
        method: 'POST', url: '/auth/login', statusCode: 200, durationMs: 284,
        responseBody: '{"token":"eyJhbGciOiJIUzI1NiJ9...","expires_in":3600}',
        extractedVars: [{ name: 'token', scope: 'global' }],
      },
      { id: 's3', type: 'think', status: 'done', text: 'Token obtained — building GET /users' },
      {
        id: 's4', type: 'http', status: 'paused', method: 'GET', url: '/users?role=admin',
        requestBody: 'GET https://api.example.com/users?role=admin\nAuthorization: Bearer {{token}}',
        resolvedVars: [{ name: 'token', scope: 'global', source: 'POST /auth/login', direction: 'in' }],
        ruleId: 'r-prod-users', ruleName: 'Pause before GET /users in prod',
        riskSummary: 'Send this request, then continue the remaining 2 steps.',
        dataScope: 'Reads production users filtered by role=admin.',
        apiRequestId: 'list-users',
      },
    ],
  },
  {
    id: 'm1',
    type: 'manual',
    name: 'POST /auth/login',
    status: 'idle',
    startedAt: Date.now() - 120000,
    environment: 'Production',
    steps: [
      { id: 'ms1', type: 'manual-input', status: 'running' },
    ],
  },
  {
    id: 'ai2',
    type: 'ai',
    name: 'Create & verify post',
    status: 'done',
    startedAt: Date.now() - 300000,
    source: 'claude-desktop',
    task: 'Create a post titled Hello World and verify it was saved',
    summary: 'Post "Hello World" created (id 101) and verified. GET /posts/101 returned matching data.',
    steps: [
      { id: 'a2s1', type: 'think', status: 'done', text: 'Plan: POST /posts then GET /posts/{id} to verify' },
      { id: 'a2s2', type: 'http', status: 'done', method: 'POST', url: '/posts', statusCode: 201, durationMs: 312 },
      { id: 'a2s3', type: 'think', status: 'done', text: 'Got id=101 — verifying with GET /posts/101' },
      { id: 'a2s4', type: 'http', status: 'done', method: 'GET', url: '/posts/101', statusCode: 200, durationMs: 198 },
    ],
  },
  {
    id: 'ai3',
    type: 'ai',
    name: 'Batch delete users',
    status: 'failed',
    startedAt: Date.now() - 600000,
    source: 'claude-desktop',
    steps: [
      { id: 'a3s1', type: 'http', status: 'done', method: 'GET', url: '/users?status=inactive', statusCode: 200, durationMs: 142 },
      {
        id: 'a3s2', type: 'http', status: 'error',
        method: 'DELETE', url: '/users/7', statusCode: 403, durationMs: 89,
        responseBody: '{"error":"Forbidden","message":"Insufficient permissions"}',
      },
    ],
  },
]

export const useSessionStore = create<AppStore>((set) => ({
  sessions: DEMO_SESSIONS,
  activeSessionId: 'ai1',
  wsStatus: 'disconnected',

  setActiveSession: (id) => set({ activeSessionId: id }),

  addSession: (s) => set((state) => ({ sessions: [s, ...state.sessions] })),

  updateSession: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    })),

  addStep: (sessionId, step) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, steps: [...s.steps, step] } : s,
      ),
    })),

  updateStep: (sessionId, stepId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, steps: s.steps.map((st) => (st.id === stepId ? { ...st, ...patch } : st)) }
          : s,
      ),
    })),

  startNewFlow: () => {
    const id = `manual-${Date.now()}`
    const stepId = `${id}-input`
    set((state) => ({
      activeSessionId: id,
      sessions: [{
        id,
        type: 'manual',
        name: 'Untitled flow',
        status: 'draft',
        startedAt: Date.now(),
        environment: 'Production',
        currentStep: 1,
        totalSteps: 1,
        steps: [{ id: stepId, type: 'manual-input', status: 'pending' }],
      }, ...state.sessions],
    }))
    return id
  },

  appendManualStep: (sessionId, request = {}) => {
    const stepId = `${sessionId}-manual-${Date.now()}`
    set((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId ? {
        ...session,
        status: session.status === 'paused' ? session.status : 'idle',
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
