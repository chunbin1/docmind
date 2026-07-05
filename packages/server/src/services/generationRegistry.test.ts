import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerGeneration, unregisterGeneration, abortGeneration,
} from './generationRegistry.js'

test('不同会话的生成互不影响，可各自 abort', () => {
  const a = registerGeneration('conv-a')
  const b = registerGeneration('conv-b')
  assert.equal(a.signal.aborted, false)
  assert.equal(b.signal.aborted, false)

  assert.equal(abortGeneration('conv-a'), true)
  assert.equal(a.signal.aborted, true)
  assert.equal(b.signal.aborted, false) // 另一会话不受影响

  assert.equal(abortGeneration('conv-a'), false) // 已移除
  unregisterGeneration('conv-b', b)
  assert.equal(abortGeneration('conv-b'), false)
})

test('同一会话重复 register 会 abort 旧的', () => {
  const first = registerGeneration('conv-x')
  const second = registerGeneration('conv-x')
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  abortGeneration('conv-x')
})
