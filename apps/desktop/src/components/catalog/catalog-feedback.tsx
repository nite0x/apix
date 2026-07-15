import { IconFlask, IconLoader2, IconRefresh } from '@tabler/icons-react'
import {
  canRetryCatalog,
  catalogStatusMessage,
  type CatalogLoadState,
} from '../../store/catalog-store'

interface Props {
  state: CatalogLoadState
  error: string | null
  isPreview: boolean
  blocking: boolean
  compact?: boolean
  onRetry: () => void
}

export function CatalogFeedback({ state, error, isPreview, blocking, compact = false, onRetry }: Props) {
  const message = catalogStatusMessage(state, error)
  const retryable = canRetryCatalog(state)
  const showState = Boolean(message) && (blocking || state === 'refreshing')

  return (
    <>
      {isPreview && (
        <div className="catalog-preview" role="status">
          <IconFlask size={12} /> Preview catalog · data is not saved
        </div>
      )}
      {showState && (
        <div
          className={`catalog-status${compact ? ' compact' : ''}${blocking ? '' : ' inline'}`}
          role={retryable ? 'alert' : 'status'}
        >
          {(state === 'loading' || state === 'refreshing') && <IconLoader2 className="catalog-spinner" size={14} />}
          <span>{message}</span>
          {retryable && (
            <button type="button" className="catalog-retry" onClick={onRetry}>
              <IconRefresh size={12} /> Retry
            </button>
          )}
        </div>
      )}
    </>
  )
}
