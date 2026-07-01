import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollupStatus, truncate } from './tracing.js'

test('rollupStatus: error beats degraded beats ok', () => {
  assert.equal(rollupStatus(['ok', 'ok']), 'ok')
  assert.equal(rollupStatus(['ok', 'degraded']), 'degraded')
  assert.equal(rollupStatus(['degraded', 'error', 'ok']), 'error')
  assert.equal(rollupStatus([]), 'ok')
})

test('truncate: caps length when content enabled', () => {
  assert.equal(truncate('hello', true, 500), 'hello')
  const long = 'x'.repeat(600)
  const out = truncate(long, true, 500)
  assert.ok(out!.startsWith('x'.repeat(500)))
  assert.ok(out!.includes('截断'))
})

test('truncate: returns null when content disabled or input empty', () => {
  assert.equal(truncate('hello', false, 500), null)
  assert.equal(truncate(undefined, true, 500), null)
  assert.equal(truncate('', true, 500), null)
})
