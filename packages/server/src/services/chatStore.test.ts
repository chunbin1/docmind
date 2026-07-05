import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  initChatTables, appendMessage, getMessages, updateMessageContent, hasGenerating,
} from './chatStore.js'

function setup() {
  const db = new Database(':memory:')
  initChatTables(db)
  return db
}

test('appendMessage 递增 seq，getMessages 按 seq 升序返回', () => {
  const db = setup()
  appendMessage('u1', { role: 'user', content: '第一句' })
  appendMessage('u1', { role: 'assistant', content: '回答一' })
  const rows = getMessages('u1')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].seq, 1)
  assert.equal(rows[1].seq, 2)
  assert.equal(rows[0].content, '第一句')
  db.close()
})

test('getMessages 按 user_id 隔离', () => {
  const db = setup()
  appendMessage('u1', { role: 'user', content: 'a' })
  appendMessage('u2', { role: 'user', content: 'b' })
  assert.equal(getMessages('u1').length, 1)
  assert.equal(getMessages('u2')[0].content, 'b')
  db.close()
})

test('updateMessageContent 写回内容并改状态', () => {
  const db = setup()
  const { id } = appendMessage('u1', { role: 'assistant', content: '', status: 'generating' })
  updateMessageContent(id, '完整答案', 'done')
  const row = getMessages('u1')[0]
  assert.equal(row.content, '完整答案')
  assert.equal(row.status, 'done')
  db.close()
})

test('hasGenerating 反映是否存在生成中的消息', () => {
  const db = setup()
  assert.equal(hasGenerating('u1'), false)
  appendMessage('u1', { role: 'assistant', content: '', status: 'generating' })
  assert.equal(hasGenerating('u1'), true)
  db.close()
})

test('崩溃兜底：重新 initChatTables 把遗留 generating 翻成 error', () => {
  const db = setup()
  appendMessage('u1', { role: 'assistant', content: '半截', status: 'generating' })
  initChatTables(db) // 模拟重启
  assert.equal(getMessages('u1')[0].status, 'error')
  db.close()
})
