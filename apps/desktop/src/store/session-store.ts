import { create } from 'zustand'

export type SessionStatus = 'running' | 'done' | 'failed' | 'idle'
export type SessionType = 'ai' | 'manual'
export type StepStatus = 'running' | 'done' | 'error' | 'skipped'
export type StepType = 'think' | 'http' | 'manual-input'

export interface ExtractedVar {
  name: string
  scope: string
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
  text?: string
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
}

export interface BackendStep {
  id: string
  type: 'request' | 'think' | 'manual'
  status: 'pending' | 'running' | 'done' | 'error' | 'paused' | 'skipped'
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  thought?: string
  error?: string
  duration_ms?: number
}

export interface BackendSession {
  id: string
  type: 'ai' | 'manual'
  status: 'running' | 'paused' | 'done' | 'error' | 'stopped'
  task?: string
  source?: string
  steps?: BackendStep[]
  created_at: string
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
  loadSessions: () => Promise<void>
  wsStatus: 'connected' | 'disconnected'
  setWsStatus: (status: 'connected' | 'disconnected') => void
}

const API_BASE_URL = 'http://127.0.0.1:4317'

export function mapBackendStep(step: BackendStep): Step {
  const input = step.input ?? {}
  const output = step.output ?? {}
  const rawBody = output.body

  return {
    id: step.id,
    type: step.type === 'request' ? 'http' : step.type === 'manual' ? 'manual-input' : 'think',
    status:
      step.status === 'done'
        ? 'done'
        : step.status === 'error'
          ? 'error'
          : step.status === 'skipped'
            ? 'skipped'
            : 'running',
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
  }
}

export function mapBackendSession(session: BackendSession): Session {
  const startedAt = Date.parse(session.created_at)
  return {
    id: session.id,
    type: session.type,
    name: session.task || 'Untitled session',
    status:
      session.status === 'done'
        ? 'done'
        : session.status === 'error' || session.status === 'stopped'
          ? 'failed'
          : 'running',
    startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
    steps: (session.steps ?? []).map(mapBackendStep),
    source: session.source,
    task: session.task,
  }
}

export const useSessionStore = create<AppStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loadState: 'idle',
  wsStatus: 'disconnected',

  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  setSessions: (sessions) =>
    set((state) => ({
      sessions,
      activeSessionId:
        state.activeSessionId && sessions.some((session) => session.id === state.activeSessionId)
          ? state.activeSessionId
          : sessions[0]?.id ?? null,
    })),

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

  setWsStatus: (wsStatus) => set({ wsStatus }),
}))
