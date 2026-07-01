// packages/server/src/services/tracing.ts
//
// Request-level tracing for the chat pipeline. A Tracer is bound per request via
// AsyncLocalStorage so instrumentation needs no signature changes across modules:
// wrap a stage with withSpan(); deep fallback points call markDegraded().
// Spans flush to SQLite (traceStore) when the request settles. Best-effort —
// tracing never breaks the request.
import { AsyncLocalStorage } from 'node:async_hooks'
import { saveTrace, appendSpan } from './traceStore.js'

export type SpanStatus = 'ok' | 'degraded' | 'error'

const TRACING_ENABLED = process.env.TRACING !== 'off'
const CONTENT_ENABLED = process.env.TRACE_CONTENT !== 'off'
const MAX_FIELD = 500

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

export interface SpanRecord {
  id: string
  trace_id: string
  parent_span_id: string | null
  name: string
  status: SpanStatus
  start_offset_ms: number
  duration_ms: number
  degraded_reason: string | null
  input: string | null
  output: string | null
  metadata: string        // JSON
  error_message: string | null
}

export interface TraceRecord {
  id: string
  route: string
  user_id: string | null
  status: SpanStatus
  duration_ms: number
  span_count: number
  degraded_count: number
  error_count: number
  started_at: string
  created_at: string
}

interface LiveSpan {
  id: string
  parentSpanId: string | null
  name: string
  status: SpanStatus
  startMs: number          // performance.now() at start
  endMs: number
  degradedReason: string | null
  input: string | null
  output: string | null
  metadata: Record<string, unknown>
  errorMessage: string | null
}

class Tracer {
  readonly id = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  readonly startMs = performance.now()
  readonly startedAt = new Date().toISOString()
  readonly spans: LiveSpan[] = []
  constructor(readonly route: string, readonly userId: string | null) {}
}

interface Ctx { tracer: Tracer; current: LiveSpan | null }

const als = new AsyncLocalStorage<Ctx>()

function genSpanId(): string {
  return `sp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

/** The current request's trace id, or null when not inside a trace. */
export function currentTraceId(): string | null {
  return als.getStore()?.tracer.id ?? null
}

/** Run `fn` inside a fresh trace; flush all spans to SQLite when it settles. */
export async function runInTrace<T>(
  meta: { route: string; userId: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!TRACING_ENABLED) return fn()
  const tracer = new Tracer(meta.route, meta.userId)
  try {
    return await als.run({ tracer, current: null }, fn)
  } finally {
    flush(tracer)
  }
}

function flush(tracer: Tracer): void {
  try {
    const spanRecords: SpanRecord[] = tracer.spans.map(s => ({
      id: s.id,
      trace_id: tracer.id,
      parent_span_id: s.parentSpanId,
      name: s.name,
      status: s.status,
      start_offset_ms: Math.round(s.startMs - tracer.startMs),
      duration_ms: Math.round(s.endMs - s.startMs),
      degraded_reason: s.degradedReason,
      input: s.input,
      output: s.output,
      metadata: JSON.stringify(s.metadata),
      error_message: s.errorMessage,
    }))
    const statuses = tracer.spans.map(s => s.status)
    const trace: TraceRecord = {
      id: tracer.id,
      route: tracer.route,
      user_id: tracer.userId,
      status: rollupStatus(statuses),
      duration_ms: Math.round(performance.now() - tracer.startMs),
      span_count: spanRecords.length,
      degraded_count: statuses.filter(s => s === 'degraded').length,
      error_count: statuses.filter(s => s === 'error').length,
      started_at: tracer.startedAt,
      created_at: new Date().toISOString(),
    }
    saveTrace(trace, spanRecords)
  } catch (err) {
    // Observability must never break the request.
    console.warn(`[tracing] flush failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Wrap an async operation in a span. Nested calls become child spans. */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const store = als.getStore()
  if (!TRACING_ENABLED || !store) return fn()
  const span: LiveSpan = {
    id: genSpanId(),
    parentSpanId: store.current?.id ?? null,
    name,
    status: 'ok',
    startMs: performance.now(),
    endMs: 0,
    degradedReason: null,
    input: null,
    output: null,
    metadata: {},
    errorMessage: null,
  }
  store.tracer.spans.push(span)
  try {
    return await als.run({ tracer: store.tracer, current: span }, fn)
  } catch (err) {
    span.status = 'error'
    span.errorMessage = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    span.endMs = performance.now()
  }
}

function current(): LiveSpan | null {
  return als.getStore()?.current ?? null
}

export function spanInput(text: string): void {
  const s = current(); if (s) s.input = truncate(text, CONTENT_ENABLED, MAX_FIELD)
}

export function spanOutput(text: string): void {
  const s = current(); if (s) s.output = truncate(text, CONTENT_ENABLED, MAX_FIELD)
}

export function spanMeta(key: string, value: unknown): void {
  const s = current(); if (s) s.metadata[key] = value
}

/** Flag the current span as degraded (a fallback / suboptimal path was taken). */
export function markDegraded(reason: string, meta?: Record<string, unknown>): void {
  const s = current()
  if (!s) return
  if (s.status === 'ok') s.status = 'degraded'   // don't downgrade an error
  s.degradedReason = reason
  if (meta) Object.assign(s.metadata, meta)
}

/**
 * Record a span for a trace that has already flushed (e.g. a fire-and-forget
 * write that failed after the response returned). `traceId` must be captured
 * via currentTraceId() before the async boundary.
 */
export function appendSpanLate(
  traceId: string,
  s: { name: string; status: SpanStatus; degradedReason?: string; errorMessage?: string; metadata?: Record<string, unknown> },
): void {
  if (!TRACING_ENABLED) return
  try {
    appendSpan({
      id: genSpanId(),
      trace_id: traceId,
      parent_span_id: null,
      name: s.name,
      status: s.status,
      start_offset_ms: 0,
      duration_ms: 0,
      degraded_reason: s.degradedReason ?? null,
      input: null,
      output: null,
      metadata: JSON.stringify(s.metadata ?? {}),
      error_message: s.errorMessage ?? null,
    })
  } catch (err) {
    console.warn(`[tracing] appendSpanLate failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
