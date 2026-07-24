import { create } from 'zustand'
import {
  CatalogError,
  deleteRun as apiDeleteRun,
  getRun,
  listRuns,
  setRunPinned,
  type BackendRun,
} from '../services/api-client'

export type RunListState = 'idle' | 'loading' | 'refreshing' | 'ready' | 'empty' | 'offline' | 'error'
export type RunDetailState = 'idle' | 'loading' | 'ready' | 'error'

export interface RunHistoryStore {
  runs: BackendRun[]
  selectedRunId: string | null
  detail: BackendRun | null
  listState: RunListState
  detailState: RunDetailState
  error: string | null
  detailError: string | null
  loaded: boolean
  loadRuns: (limit?: number) => Promise<void>
  refresh: () => Promise<void>
  /** Reloads only when the list has already been opened at least once. */
  refreshIfLoaded: () => void
  selectRun: (id: string | null) => Promise<void>
  togglePinned: (id: string) => Promise<void>
  deleteRun: (id: string) => Promise<void>
}

let listSequence = 0
let detailSequence = 0

function listStateFor(runs: BackendRun[]): RunListState {
  return runs.length === 0 ? 'empty' : 'ready'
}

export const useRunHistoryStore = create<RunHistoryStore>((set, get) => ({
  runs: [],
  selectedRunId: null,
  detail: null,
  listState: 'idle',
  detailState: 'idle',
  error: null,
  detailError: null,
  loaded: false,

  loadRuns: async (limit) => {
    const sequence = ++listSequence
    const refreshing = get().runs.length > 0
    set({ listState: refreshing ? 'refreshing' : 'loading', error: null })
    try {
      const runs = await listRuns({ limit })
      if (sequence !== listSequence) return
      set({ runs, listState: listStateFor(runs), error: null, loaded: true })
    } catch (error) {
      if (sequence !== listSequence) return
      const offline = error instanceof CatalogError && error.kind === 'offline'
      set({
        listState: offline ? 'offline' : 'error',
        error: error instanceof Error ? error.message : 'Failed to load runs',
        loaded: true,
      })
    }
  },

  refresh: async () => {
    await get().loadRuns()
  },

  refreshIfLoaded: () => {
    if (get().loaded) void get().loadRuns()
  },

  selectRun: async (id) => {
    if (id == null) {
      set({ selectedRunId: null, detail: null, detailState: 'idle', detailError: null })
      return
    }
    const sequence = ++detailSequence
    // Show the list snapshot immediately, then refresh the detail from the runtime.
    const snapshot = get().runs.find((run) => run.id === id) ?? null
    set({ selectedRunId: id, detail: snapshot, detailState: 'loading', detailError: null })
    try {
      const run = await getRun(id)
      if (sequence !== detailSequence) return
      set({ detail: run, detailState: 'ready', detailError: null })
    } catch (error) {
      if (sequence !== detailSequence) return
      set({
        detailState: snapshot ? 'ready' : 'error',
        detailError: error instanceof Error ? error.message : 'Failed to load run',
      })
    }
  },

  togglePinned: async (id) => {
    const current = get().runs.find((run) => run.id === id)
    if (!current) return
    const nextPinned = !current.is_pinned
    const apply = (pinned: boolean) => set((state) => ({
      runs: state.runs.map((run) => (run.id === id ? { ...run, is_pinned: pinned } : run)),
      detail: state.detail && state.detail.id === id ? { ...state.detail, is_pinned: pinned } : state.detail,
    }))
    // Optimistic update, rolled back if the runtime rejects the change.
    apply(nextPinned)
    try {
      await setRunPinned(id, nextPinned)
    } catch (error) {
      apply(current.is_pinned)
      throw error
    }
  },

  deleteRun: async (id) => {
    await apiDeleteRun(id)
    set((state) => {
      const runs = state.runs.filter((run) => run.id !== id)
      const wasSelected = state.selectedRunId === id
      return {
        runs,
        listState: listStateFor(runs),
        selectedRunId: wasSelected ? null : state.selectedRunId,
        detail: wasSelected ? null : state.detail,
        detailState: wasSelected ? 'idle' : state.detailState,
        detailError: wasSelected ? null : state.detailError,
      }
    })
  },
}))
