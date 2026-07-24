import { describe, expect, it } from 'vitest'
import { formatDuration, formatJson, formatSize, formatTimestamp } from './format'

describe('formatDuration', () => {
  it('formats sub-second, seconds and minutes', () => {
    expect(formatDuration(240)).toBe('240ms')
    expect(formatDuration(1500)).toBe('1.50s')
    expect(formatDuration(65000)).toBe('1m 5s')
    expect(formatDuration(undefined)).toBe('—')
  })
})

describe('formatSize', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatSize(512)).toBe('512B')
    expect(formatSize(2048)).toBe('2.0KB')
    expect(formatSize(undefined)).toBe('—')
  })
})

describe('formatTimestamp', () => {
  it('returns a dash for invalid input', () => {
    expect(formatTimestamp('not-a-date')).toBe('—')
    expect(formatTimestamp(null)).toBe('—')
  })

  it('formats a valid ISO timestamp', () => {
    expect(formatTimestamp('2026-07-24T10:00:00Z')).not.toBe('—')
  })
})

describe('formatJson', () => {
  it('pretty-prints objects and arrays', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('pretty-prints embedded JSON strings but leaves plain text alone', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(formatJson('plain text')).toBe('plain text')
  })

  it('never throws on null or non-serializable values', () => {
    expect(formatJson(null)).toBe('')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => formatJson(circular)).not.toThrow()
  })
})
