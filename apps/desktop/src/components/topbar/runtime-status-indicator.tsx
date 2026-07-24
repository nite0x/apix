import { IconRefresh } from '@tabler/icons-react'
import { useSessionStore } from '../../store/session-store'
import {
  deriveRuntimeStatus,
  runtimeStatusLabel,
  useRuntimeStatusStore,
} from '../../store/runtime-status-store'

interface Props {
  onRetry: () => void
}

/**
 * Compact, always-visible runtime connection indicator. It stays mounted even
 * when there is no active session so the user can always see connectivity and
 * retry an offline runtime.
 */
export function RuntimeStatusIndicator({ onRetry }: Props) {
  const httpStatus = useRuntimeStatusStore((s) => s.httpStatus)
  const wsStatus = useSessionStore((s) => s.wsStatus)
  const status = deriveRuntimeStatus(httpStatus, wsStatus)
  const label = runtimeStatusLabel(status)
  const canRetry = status === 'offline' || status === 'degraded'

  return (
    <div className={`rt-status rt-${status}`} role="status" aria-live="polite" aria-label={label}>
      <span className="rt-dot" aria-hidden="true" />
      <span className="rt-label">{label}</span>
      {canRetry && (
        <button type="button" className="rt-retry" aria-label="重试连接 Runtime" onClick={onRetry}>
          <IconRefresh size={11} /> 重试
        </button>
      )}
    </div>
  )
}
