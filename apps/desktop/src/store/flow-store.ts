import { create } from 'zustand'
import {
  createFlow as apiCreateFlow,
  deleteFlow as apiDeleteFlow,
  duplicateFlow as apiDuplicateFlow,
  getFlow,
  listFlows,
  patchFlow,
  putFlow,
  restoreFlow as apiRestoreFlow,
  FlowConflictError,
  type Flow,
  type FlowSummary,
} from '../services/flow-client'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export const AUTOSAVE_DEBOUNCE_MS = 600

export interface FlowStore {
  summaries: FlowSummary[]
  entities: Record<string, Flow>
  drafts: Record<string, Flow>
  selectedFlowId: string | null
  listState: 'idle' | 'loading' | 'ready' | 'error'
  saveStateById: Record<string, SaveState>
  errorById: Record<string, string | undefined>

  loadFlows: () => Promise<void>
  selectFlow: (id: string) => Promise<void>
  createFlow: () => Promise<Flow>
  updateDraft: (id: string, updater: (draft: Flow) => Flow) => void
  flushSave: (id: string) => Promise<Flow | undefined>
  renameFlow: (id: string, name: string) => Promise<void>
  duplicateFlow: (id: string) => Promise<Flow>
  deleteFlow: (id: string) => Promise<void>
  restoreFlow: (id: string) => Promise<void>
  reloadServerVersion: (id: string) => Promise<void>
}

// Per-flow bookkeeping kept outside the reactive store.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const draftRevision = new Map<string, number>() // latest local edit revision
const inFlight = new Map<string, Promise<Flow | undefined>>()

function bumpRevision(id: string): number {
  const next = (draftRevision.get(id) ?? 0) + 1
  draftRevision.set(id, next)
  return next
}

export const useFlowStore = create<FlowStore>((set, get) => ({
  summaries: [],
  entities: {},
  drafts: {},
  selectedFlowId: null,
  listState: 'idle',
  saveStateById: {},
  errorById: {},

  loadFlows: async () => {
    set({ listState: 'loading' })
    try {
      const summaries = await listFlows()
      // Never clobber an open dirty draft with a lighter summary; summaries are
      // a separate projection from the editable aggregate.
      set({ summaries, listState: 'ready' })
    } catch {
      set({ listState: 'error' })
    }
  },

  selectFlow: async (id) => {
    const prev = get().selectedFlowId
    if (prev && prev !== id) {
      // Flush the outgoing flow before switching.
      await get().flushSave(prev).catch(() => undefined)
    }
    set({ selectedFlowId: id })
    // Keep an already-open (possibly dirty) draft instead of reloading it.
    if (get().drafts[id]) return
    try {
      const flow = await getFlow(id)
      set((state) => ({
        entities: { ...state.entities, [id]: flow },
        drafts: { ...state.drafts, [id]: flow },
        saveStateById: { ...state.saveStateById, [id]: 'saved' },
      }))
    } catch {
      set((state) => ({ saveStateById: { ...state.saveStateById, [id]: 'error' } }))
    }
  },

  createFlow: async () => {
    const flow = await apiCreateFlow()
    const summary: FlowSummary = {
      id: flow.id,
      project_id: flow.project_id,
      name: flow.name,
      description: flow.description,
      environment_id: flow.environment_id,
      step_count: flow.steps.length,
      edit_version: flow.edit_version,
      created_at: flow.created_at,
      updated_at: flow.updated_at,
      archived_at: null,
    }
    set((state) => ({
      summaries: [summary, ...state.summaries],
      entities: { ...state.entities, [flow.id]: flow },
      drafts: { ...state.drafts, [flow.id]: flow },
      saveStateById: { ...state.saveStateById, [flow.id]: 'saved' },
      selectedFlowId: flow.id,
    }))
    return flow
  },

  updateDraft: (id, updater) => {
    const current = get().drafts[id]
    if (!current) return
    const next = updater(current)
    bumpRevision(id)
    set((state) => ({
      drafts: { ...state.drafts, [id]: next },
      saveStateById: { ...state.saveStateById, [id]: state.saveStateById[id] === 'saving' ? 'saving' : 'dirty' },
    }))
    const existing = debounceTimers.get(id)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      id,
      setTimeout(() => {
        debounceTimers.delete(id)
        void get().flushSave(id)
      }, AUTOSAVE_DEBOUNCE_MS),
    )
  },

  flushSave: async (id) => {
    const timer = debounceTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(id)
    }
    const draft = get().drafts[id]
    if (!draft) return get().entities[id]
    // Nothing to do if already in sync.
    if (get().saveStateById[id] === 'saved') return get().entities[id]
    // Serialize: if a save is running, the running loop will pick up newer edits.
    const running = inFlight.get(id)
    if (running) return running

    const runSave = async (): Promise<Flow | undefined> => {
      try {
        // Loop until the on-disk version matches the latest local revision.
        // Concurrent edits during a save keep the flow dirty and trigger a retry.
        for (;;) {
          const revAtStart = draftRevision.get(id) ?? 0
          const currentDraft = get().drafts[id]
          if (!currentDraft) return get().entities[id]
          set((state) => ({ saveStateById: { ...state.saveStateById, [id]: 'saving' } }))
          const saved = await putFlow(currentDraft)
          const revNow = draftRevision.get(id) ?? 0
          if (revNow !== revAtStart) {
            // The user edited during the save. Carry the new server version
            // forward and save again; do not show "saved".
            set((state) => ({
              entities: { ...state.entities, [id]: saved },
              drafts: state.drafts[id]
                ? { ...state.drafts, [id]: { ...state.drafts[id], edit_version: saved.edit_version } }
                : state.drafts,
            }))
            continue
          }
          set((state) => ({
            entities: { ...state.entities, [id]: saved },
            drafts: { ...state.drafts, [id]: saved },
            saveStateById: { ...state.saveStateById, [id]: 'saved' },
            errorById: { ...state.errorById, [id]: undefined },
            summaries: state.summaries.map((s) =>
              s.id === id
                ? { ...s, name: saved.name, description: saved.description, edit_version: saved.edit_version, step_count: saved.steps.length, updated_at: saved.updated_at }
                : s,
            ),
          }))
          return saved
        }
      } catch (error) {
        if (error instanceof FlowConflictError) {
          set((state) => ({
            saveStateById: { ...state.saveStateById, [id]: 'conflict' },
            errorById: { ...state.errorById, [id]: 'This flow was modified elsewhere' },
          }))
          return undefined
        }
        set((state) => ({
          saveStateById: { ...state.saveStateById, [id]: 'error' },
          errorById: { ...state.errorById, [id]: error instanceof Error ? error.message : 'Save failed' },
        }))
        return undefined
      } finally {
        inFlight.delete(id)
      }
    }

    const promise = runSave()
    inFlight.set(id, promise)
    return promise
  },

  renameFlow: async (id, name) => {
    const trimmed = name.trim()
    const editVersion = get().drafts[id]?.edit_version ?? get().entities[id]?.edit_version
      ?? get().summaries.find((s) => s.id === id)?.edit_version ?? 1
    try {
      const flow = await patchFlow(id, { name: trimmed, edit_version: editVersion })
      set((state) => ({
        entities: { ...state.entities, [id]: flow },
        drafts: state.drafts[id] ? { ...state.drafts, [id]: { ...state.drafts[id], name: flow.name, edit_version: flow.edit_version } } : state.drafts,
        summaries: state.summaries.map((s) => (s.id === id ? { ...s, name: flow.name, edit_version: flow.edit_version } : s)),
      }))
    } catch (error) {
      if (error instanceof FlowConflictError) {
        set((state) => ({ saveStateById: { ...state.saveStateById, [id]: 'conflict' } }))
        return
      }
      throw error
    }
  },

  duplicateFlow: async (id) => {
    const flow = await apiDuplicateFlow(id)
    const summary: FlowSummary = {
      id: flow.id, project_id: flow.project_id, name: flow.name, description: flow.description,
      environment_id: flow.environment_id, step_count: flow.steps.length, edit_version: flow.edit_version,
      created_at: flow.created_at, updated_at: flow.updated_at, archived_at: null,
    }
    set((state) => ({
      summaries: [summary, ...state.summaries],
      entities: { ...state.entities, [flow.id]: flow },
      drafts: { ...state.drafts, [flow.id]: flow },
      saveStateById: { ...state.saveStateById, [flow.id]: 'saved' },
    }))
    return flow
  },

  deleteFlow: async (id) => {
    await apiDeleteFlow(id)
    set((state) => {
      const nextSelected = state.selectedFlowId === id
        ? state.summaries.find((s) => s.id !== id && !s.archived_at)?.id ?? null
        : state.selectedFlowId
      return {
        summaries: state.summaries.filter((s) => s.id !== id),
        selectedFlowId: nextSelected,
      }
    })
  },

  restoreFlow: async (id) => {
    await apiRestoreFlow(id)
    await get().loadFlows()
  },

  reloadServerVersion: async (id) => {
    const flow = await getFlow(id)
    set((state) => ({
      entities: { ...state.entities, [id]: flow },
      drafts: { ...state.drafts, [id]: flow },
      saveStateById: { ...state.saveStateById, [id]: 'saved' },
      errorById: { ...state.errorById, [id]: undefined },
    }))
  },
}))
