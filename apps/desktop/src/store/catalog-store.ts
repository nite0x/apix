import { create } from 'zustand'
import { allApis, type ApiCollectionGroup, type ApiDefinition } from '../data/api-catalog'
import { CatalogError, loadCatalog as fetchCatalog } from '../services/api-client'

export type CatalogLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'offline' | 'error'

interface CatalogStore {
  groups: ApiCollectionGroup[]
  loadState: CatalogLoadState
  error: string | null
  /** Load or reload catalog from the runtime. Shared by all consumers. */
  refresh: () => Promise<void>
  /** Replace catalog after a successful CRUD mutation (keeps consumers in sync). */
  setGroups: (groups: ApiCollectionGroup[]) => void
  findApi: (id: string) => ApiDefinition | undefined
}

function stateForGroups(groups: ApiCollectionGroup[]): CatalogLoadState {
  return groups.length === 0 ? 'empty' : 'ready'
}

export const useCatalogStore = create<CatalogStore>((set, get) => ({
  groups: [],
  loadState: 'idle',
  error: null,

  setGroups: (groups) => set({
    groups,
    loadState: stateForGroups(groups),
    error: null,
  }),

  findApi: (id) => allApis(get().groups).find((api) => api.id === id),

  refresh: async () => {
    set({ loadState: 'loading', error: null })
    try {
      const groups = await fetchCatalog()
      set({
        groups,
        loadState: stateForGroups(groups),
        error: null,
      })
    } catch (error) {
      const failure = error instanceof CatalogError
        ? error
        : new CatalogError('error', error instanceof Error ? error.message : 'Failed to load catalog')
      set({
        groups: [],
        loadState: failure.kind === 'offline' ? 'offline' : 'error',
        error: failure.message,
      })
    }
  },
}))

export function catalogStatusMessage(state: CatalogLoadState, error: string | null): string | null {
  switch (state) {
    case 'loading':
      return 'Loading catalog…'
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
