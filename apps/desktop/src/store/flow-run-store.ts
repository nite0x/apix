import { create } from 'zustand'
import {
  cancelFlowRun,
  getFlowRun,
  listFlowRuns,
  startFlowRun,
  type Flow,
  type FlowRun,
  type FlowRunStatus,
  type FlowRunStepStatus,
} from '../services/flow-client'
import { useFlowStore } from './flow-store'

export interface FlowRunEvent {
  type: string
  session_id: string // carries flow_run.id
  step_id?: string
  payload?: Record<string, unknown>
}

export interface FlowRunStore {
  runsById: Record<string, FlowRun>
  runIdsByFlow: Record<string, string[]>
  activeRunId: string | null
  startState: 'idle' | 'starting' | 'error'
  startError: string | undefined

  startRun: (flow: Flow, variables?: Record<string, string>) => Promise<FlowRun | undefined>
  cancelRun: (runId: string) => Promise<void>
  loadRuns: (flowId: string) => Promise<void>
  openRun: (runId: string) => Promise<void>
  setRun: (run: FlowRun) => void
  applyEvent: (event: FlowRunEvent) => void
  resync: (runId: string) => Promise<void>
}

export const useFlowRunStore = create<FlowRunStore>((set, get) => ({
  runsById: {},
  runIdsByFlow: {},
  activeRunId: null,
  startState: 'idle',
  startError: undefined,

  startRun: async (flow, variables) => {
    set({ startState: 'starting', startError: undefined })
    // Run only what was saved: flush pending edits first and abort on failure.
    const saved = await useFlowStore.getState().flushSave(flow.id).catch(() => undefined)
    const state = useFlowStore.getState().saveStateById[flow.id]
    if (state === 'error' || state === 'conflict') {
      set({ startState: 'error', startError: 'Save the flow before running it' })
      return undefined
    }
    const version = saved?.edit_version ?? useFlowStore.getState().drafts[flow.id]?.edit_version ?? flow.edit_version
    try {
      const run = await startFlowRun(flow.id, {
        expected_flow_version: version,
        environment_id: flow.environment_id ?? undefined,
        variables,
      })
      get().setRun(run)
      set({ activeRunId: run.id, startState: 'idle' })
      return run
    } catch (error) {
      set({ startState: 'error', startError: error instanceof Error ? error.message : 'Failed to start run' })
      return undefined
    }
  },

  cancelRun: async (runId) => {
    try {
      const run = await cancelFlowRun(runId)
      get().setRun(run)
    } catch {
      void get().resync(runId)
    }
  },

  loadRuns: async (flowId) => {
    try {
      const runs = await listFlowRuns(flowId)
      set((s) => {
        const runsById = { ...s.runsById }
        for (const run of runs) runsById[run.id] = run
        return { runsById, runIdsByFlow: { ...s.runIdsByFlow, [flowId]: runs.map((r) => r.id) } }
      })
    } catch {
      // Ignore; the sidebar simply shows no history until the next refresh.
    }
  },

  openRun: async (runId) => {
    set({ activeRunId: runId })
    await get().resync(runId)
  },

  setRun: (run) => {
    set((s) => {
      const ids = s.runIdsByFlow[run.flow_id ?? ''] ?? []
      const runIdsByFlow = run.flow_id && !ids.includes(run.id)
        ? { ...s.runIdsByFlow, [run.flow_id]: [run.id, ...ids] }
        : s.runIdsByFlow
      return { runsById: { ...s.runsById, [run.id]: run }, runIdsByFlow }
    })
  },

  applyEvent: (event) => {
    const runId = event.session_id
    const run = get().runsById[runId]
    if (!run) {
      // We received an event for a run we don't have yet; pull the full state.
      void get().resync(runId)
      return
    }
    const next: FlowRun = { ...run, steps: run.steps ? [...run.steps] : run.steps }
    switch (event.type) {
      case 'flow_run.started':
        next.status = 'running'
        break
      case 'flow_run.step_started':
        applyStepStatus(next, event.step_id, 'running')
        break
      case 'flow_run.step_paused':
        next.status = 'paused'
        applyStepStatus(next, event.step_id, 'paused')
        break
      case 'flow_run.step_finished':
        applyStepStatus(next, event.step_id, (event.payload?.status as FlowRunStepStatus) ?? 'succeeded')
        break
      case 'flow_run.finished':
        next.status = (event.payload?.status as FlowRunStatus) ?? next.status
        break
      default:
        return
    }
    set((s) => ({ runsById: { ...s.runsById, [runId]: next } }))
  },

  resync: async (runId) => {
    try {
      const run = await getFlowRun(runId)
      get().setRun(run)
    } catch {
      // Nothing to do; the run may have been deleted.
    }
  },
}))

function applyStepStatus(run: FlowRun, stepId: string | undefined, status: FlowRunStepStatus) {
  if (!stepId || !run.steps) return
  run.steps = run.steps.map((step) => (step.id === stepId ? { ...step, status } : step))
}
