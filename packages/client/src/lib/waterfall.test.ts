import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWaterfall } from './waterfall.ts'
import type { SpanRecord } from '../types.ts'

function span(p: Partial<SpanRecord>): SpanRecord {
  return {
    id: 'sp', trace_id: 'tr', parent_span_id: null, name: 'x',
    status: 'ok', start_offset_ms: 0, duration_ms: 0,
    degraded_reason: null, input: null, output: null,
    metadata: '{}', error_message: null,
    ...p,
  }
}

test('単個根 span：depth=0，按 total 计算百分比', () => {
  const rows = buildWaterfall([span({ id: 'a', start_offset_ms: 0, duration_ms: 50 })], 100)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[0].leftPct, 0)
  assert.equal(rows[0].widthPct, 50)
})

test('子 span：depth 随 parent 链递增', () => {
  const spans = [
    span({ id: 'a', start_offset_ms: 0, duration_ms: 100 }),
    span({ id: 'b', parent_span_id: 'a', start_offset_ms: 10, duration_ms: 20 }),
    span({ id: 'c', parent_span_id: 'b', start_offset_ms: 12, duration_ms: 5 }),
  ]
  const rows = buildWaterfall(spans, 100)
  assert.equal(rows[1].depth, 1)
  assert.equal(rows[1].leftPct, 10)
  assert.equal(rows[1].widthPct, 20)
  assert.equal(rows[2].depth, 2)
})

test('totalMs<=0 时回退到 max(offset+duration)', () => {
  const spans = [
    span({ id: 'a', start_offset_ms: 0, duration_ms: 40 }),
    span({ id: 'b', start_offset_ms: 60, duration_ms: 40 }), // 末端 100
  ]
  const rows = buildWaterfall(spans, 0)
  assert.equal(rows[1].leftPct, 60)
  assert.equal(rows[1].widthPct, 40)
})

test('duration_ms=0 给最小可见宽度', () => {
  const rows = buildWaterfall([span({ id: 'a', start_offset_ms: 10, duration_ms: 0 })], 100)
  assert.equal(rows[0].widthPct, 0.5)
})

test('空数组返回空数组', () => {
  assert.deepEqual(buildWaterfall([], 100), [])
})
