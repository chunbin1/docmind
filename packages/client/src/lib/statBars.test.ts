import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statBars } from './statBars.ts'

test('按次数降序排列', () => {
  const bars = statBars({ a: 2, b: 5, c: 1 })
  assert.deepEqual(bars.map(x => x.reason), ['b', 'a', 'c'])
})

test('pct 按最大值归一化（最多的占满 100）', () => {
  const bars = statBars({ a: 5, b: 10 })
  assert.equal(bars[0].reason, 'b')
  assert.equal(bars[0].pct, 100)
  assert.equal(bars[1].reason, 'a')
  assert.equal(bars[1].pct, 50)
})

test('空对象返回空数组', () => {
  assert.deepEqual(statBars({}), [])
})

test('单一原因占满 100', () => {
  const bars = statBars({ only: 3 })
  assert.equal(bars.length, 1)
  assert.equal(bars[0].pct, 100)
  assert.equal(bars[0].count, 3)
})

test('并列次数保留全部项', () => {
  const bars = statBars({ a: 4, b: 4 })
  assert.equal(bars.length, 2)
  assert.equal(bars[0].pct, 100)
  assert.equal(bars[1].pct, 100)
})
