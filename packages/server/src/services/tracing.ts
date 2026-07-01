// packages/server/src/services/tracing.ts
export type SpanStatus = 'ok' | 'degraded' | 'error'

/** Roll child span statuses up into one trace status: error > degraded > ok. */
export function rollupStatus(statuses: SpanStatus[]): SpanStatus {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('degraded')) return 'degraded'
  return 'ok'
}

/** Truncate content for storage. Returns null when disabled or empty. */
export function truncate(
  s: string | null | undefined,
  contentEnabled: boolean,
  max: number,
): string | null {
  if (!contentEnabled) return null
  if (!s) return null
  if (s.length <= max) return s
  return `${s.slice(0, max)}…（截断 ${s.length - max} 字）`
}
