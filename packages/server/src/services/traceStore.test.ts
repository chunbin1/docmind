import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  initTraceTables, saveTrace, getTrace, listTraces, appendSpan, traceStats,
} from './traceStore.js'
import type { TraceRecord, SpanRecord } from './tracing.js'

function setup() {
  const db = new Database(':memory:')
  initTraceTables(db)
  return db
}

function mkTrace(id: string, status: TraceRecord['status'] = 'ok', degraded = 0): TraceRecord {
  return {
    id, route: '/chat/stream', user_id: 'u1', status,
    duration_ms: 100, span_count: 1, degraded_count: degraded, error_count: 0,
    started_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z',
  }
}
function mkSpan(id: string, traceId: string, over: Partial<SpanRecord> = {}): SpanRecord {
  return {
    id, trace_id: traceId, parent_span_id: null, name: 'memory_retrieval',
    status: 'ok', start_offset_ms: 0, duration_ms: 10, degraded_reason: null,
    input: 'q', output: 'r', metadata: '{}', error_message: null, ...over,
  }
}

test('saveTrace + getTrace round-trips trace and spans', () => {
  const db = setup()
  saveTrace(mkTrace('tr_1'), [mkSpan('sp_1', 'tr_1'), mkSpan('sp_2', 'tr_1')])
  const got = getTrace('tr_1')
  assert.equal(got?.trace.id, 'tr_1')
  assert.equal(got?.spans.length, 2)
  assert.equal(got?.spans[0].name, 'memory_retrieval')
  db.close()
})

test('listTraces filters by status', () => {
  const db = setup()
  saveTrace(mkTrace('tr_ok', 'ok'), [])
  saveTrace(mkTrace('tr_deg', 'degraded', 1), [])
  const degraded = listTraces({ status: 'degraded', limit: 10 })
  assert.equal(degraded.length, 1)
  assert.equal(degraded[0].id, 'tr_deg')
  db.close()
})

test('appendSpan adds a late span and bumps degraded_count + status', () => {
  const db = setup()
  saveTrace(mkTrace('tr_1', 'ok', 0), [mkSpan('sp_1', 'tr_1')])
  appendSpan(mkSpan('sp_late', 'tr_1', {
    name: 'memory_vector_write', status: 'degraded', degraded_reason: 'memory_vector_write_failed',
  }))
  const got = getTrace('tr_1')
  assert.equal(got?.spans.length, 2)
  assert.equal(got?.trace.degraded_count, 1)
  assert.equal(got?.trace.status, 'degraded')
  db.close()
})

test('traceStats reports degradedPct and byReason', () => {
  const db = setup()
  saveTrace(mkTrace('tr_ok', 'ok', 0), [mkSpan('s1', 'tr_ok')])
  saveTrace(mkTrace('tr_deg', 'degraded', 1),
    [mkSpan('s2', 'tr_deg', { status: 'degraded', degraded_reason: 'memory_fts_fallback' })])
  const stats = traceStats({})
  assert.equal(stats.total, 2)
  assert.equal(stats.degradedPct, 50)
  assert.equal(stats.byReason.memory_fts_fallback, 1)
  db.close()
})
