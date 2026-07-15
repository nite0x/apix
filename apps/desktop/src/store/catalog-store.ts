import { create } from 'zustand'
import { allApis, type ApiCollectionGroup, type ApiDefinition } from '../data/api-catalog'
import { CatalogError, loadCatalog as fetchCatalog } from '../services/api-client'

export type CatalogLoadState = 'idle' | 'loading' | 'refreshing' | 'ready' | 'empty' | 'offline' | 'error'

export interface CatalogStore {
  groups: ApiCollectionGroup[]
  loadState: CatalogLoadState
  error: string | null
  isPreview: boolean
  revision: number
  /** Load or reload catalog from the runtime. Shared by all consumers. */
  refresh: () => Promise<void>
  /** Run a Catalog mutation, then publish one refreshed version to every consumer. */
  runMutation: <T>(mutation: () => Promise<T>) => Promise<T>
  findApi: (id: string) => ApiDefinition | undefined
}

let refreshSequence = 0

function stateForGroups(groups: ApiCollectionGroup[]): CatalogLoadState {
  return groups.length === 0 ? 'empty' : 'ready'
}

export const useCatalogStore = create<CatalogStore>((set, get) => ({
  groups: [],
  loadState: 'idle',
  error: null,
  isPreview: false,
  revision: 0,

  findApi: (id) => allApis(get().groups).find((api) => api.id === id),

  refresh: async () => {
    const sequence = ++refreshSequence
    const refreshing = get().groups.length > 0
    set({ loadState: refreshing ? 'refreshing' : 'loading', error: null })
    try {
      const groups = await fetchCatalog()
      if (sequence !== refreshSequence) return
      set({
        groups,
        loadState: stateForGroups(groups),
        error: null,
        isPreview: groups.some((group) => group.apis.some((api) => api.source === 'fixture')),
        revision: get().revision + 1,
      })
    } catch (error) {
      if (sequence !== refreshSequence) return
      const failure = error instanceof CatalogError
        ? error
        : new CatalogError('error', error instanceof Error ? error.message : 'Failed to load catalog')
      set({
        groups: [],
        loadState: failure.kind === 'offline' ? 'offline' : 'error',
        error: failure.message,
        isPreview: false,
      })
    }
  },

  runMutation: async (mutation) => {
    const result = await mutation()
    await get().refresh()
    return result
  },
}))

export function catalogStatusMessage(state: CatalogLoadState, error: string | null): string | null {
  switch (state) {
    case 'loading':
      return 'Loading catalog…'
    case 'refreshing':
      return 'Refreshing catalog…'
    case 'empty':
      return 'No saved APIs yet'
    case 'offline':
      return 'Runtime unavailable'
    case 'error':
      return error ?? 'Failed to load catalog'
    default:
      return null
  }
}

export function canRetryCatalog(state: CatalogLoadState): boolean {
  return state === 'offline' || state === 'error'
}
