/**
 * Small shared formatting helpers so date/duration/size rendering stays
 * consistent across the run history, timeline and detail surfaces instead of
 * being reimplemented per component.
 */

/** Formats a duration in milliseconds as a compact human string. */
export function formatDuration(ms?: number | null): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}

/** Formats a byte count as a compact size string. */
export function formatSize(bytes?: number | null): string {
  if (bytes == null || Number.isNaN(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Absolute local timestamp, e.g. "07-24 15:30:12". Returns "—" when invalid. */
export function formatTimestamp(value?: string | number | null): string {
  if (value == null || value === '') return '—'
  const date = new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time)) return '—'
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** Short clock time, e.g. "15:30". Returns "—" when invalid. */
export function formatClock(value?: string | number | null): string {
  if (value == null || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Safely stringifies an unknown JSON value for display. Strings are returned
 * as-is (pretty-printed when they contain embedded JSON); everything else is
 * pretty-printed. Values that cannot be serialized fall back to String().
 */
export function formatJson(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2)
      } catch {
        return value
      }
    }
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
