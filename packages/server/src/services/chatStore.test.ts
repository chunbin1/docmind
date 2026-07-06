import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  initChatTables, createConversation, getConversation, listConversations,
  deleteConversation, setConversationTitle, titleFromMessage,
  appendMessage, getMessages, updateMessageContent, hasGenerating,
  replaceForCompaction, markErrorIfGenerating,
  DEFAULT_CONVERSATION_TITLE,
} from './chatStore.js'

function setup() {
  const db = new Database(':memory:')
  initChatTables(db)
  return db
}

test('createConversation 建会话，默认标题', () => {
  const db = setup()
  const { id } = createConversation('u1')
  const conv = getConversation(id)
  assert.equal(conv?.user_id, 'u1')
  assert.equal(conv?.title, DEFAULT_CONVERSATION_TITLE)
  db.close()
})

test('appendMessage 的 seq 按会话独立递增', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const c2 = createConversation('u1').id
  appendMessage('u1', c1, { role: 'user', content: 'a1' })
  appendMessage('u1', c1, { role: 'assistant', content: 'a2' })
  appendMessage('u1', c2, { role: 'user', content: 'b1' })
  assert.deepEqual(getMessages(c1).map(m => m.seq), [1, 2])
  assert.deepEqual(getMessages(c2).map(m => m.seq), [1])
  assert.equal(getMessages(c2)[0].content, 'b1')
  db.close()
})

test('getMessages 按 conversation 隔离', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const c2 = createConversation('u1').id
  appendMessage('u1', c1, { role: 'user', content: 'x' })
  assert.equal(getMessages(c1).length, 1)
  assert.equal(getMessages(c2).length, 0)
  db.close()
})

test('appendMessage 刷新 conversation.updated_at', async () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const before = getConversation(c1)!.updated_at
  await new Promise(r => setTimeout(r, 5))
  appendMessage('u1', c1, { role: 'user', content: 'x' })
  assert.notEqual(getConversation(c1)!.updated_at, before)
  db.close()
})

test('listConversations 按 updated_at 倒序，含 message_count 与 generating', async () => {
  const db = setup()
  const c1 = createConversation('u1').id
  await new Promise(r => setTimeout(r, 5))
  const c2 = createConversation('u1').id
  appendMessage('u1', c1, { role: 'user', content: 'q' })
  appendMessage('u1', c1, { role: 'assistant', content: '', status: 'generating' })
  const list = listConversations('u1')
  // c1 因刚追加消息 updated_at 更新，排最前
  assert.equal(list[0].id, c1)
  assert.equal(list[0].message_count, 2)
  assert.equal(list[0].generating, true)
  assert.equal(list[1].id, c2)
  assert.equal(list[1].message_count, 0)
  assert.equal(list[1].generating, false)
  db.close()
})

test('listConversations 只列本用户会话', () => {
  const db = setup()
  createConversation('u1')
  createConversation('u2')
  assert.equal(listConversations('u1').length, 1)
  assert.equal(listConversations('u2').length, 1)
  db.close()
})

test('deleteConversation 级联删消息，且校验归属', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  appendMessage('u1', c1, { role: 'user', content: 'x' })
  assert.equal(deleteConversation('u2', c1), false) // 越权拒绝
  assert.equal(getMessages(c1).length, 1)
  assert.equal(deleteConversation('u1', c1), true)
  assert.equal(getConversation(c1), undefined)
  assert.equal(getMessages(c1).length, 0)
  db.close()
})

test('hasGenerating 按会话判断', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const c2 = createConversation('u1').id
  appendMessage('u1', c1, { role: 'assistant', content: '', status: 'generating' })
  assert.equal(hasGenerating(c1), true)
  assert.equal(hasGenerating(c2), false)
  db.close()
})

test('setConversationTitle 改标题', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  setConversationTitle(c1, '天气问答')
  assert.equal(getConversation(c1)!.title, '天气问答')
  db.close()
})

test('titleFromMessage 取首行并截断 24 字', () => {
  assert.equal(titleFromMessage('广州天气如何'), '广州天气如何')
  assert.equal(titleFromMessage('第一行\n第二行'), '第一行')
  assert.equal(titleFromMessage('a'.repeat(30)), 'a'.repeat(24) + '…')
  assert.equal(titleFromMessage('   '), DEFAULT_CONVERSATION_TITLE)
})

test('replaceForCompaction 按会话删旧行并头插 summary', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const a = appendMessage('u1', c1, { role: 'user', content: '旧问1' })
  const b = appendMessage('u1', c1, { role: 'assistant', content: '旧答1' })
  appendMessage('u1', c1, { role: 'user', content: '近问' })
  replaceForCompaction('u1', c1, [a.id, b.id], '这是摘要')
  const rows = getMessages(c1)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].role, 'summary')
  assert.equal(rows[0].content, '这是摘要')
  assert.equal(rows[0].compacted_count, 2)
  assert.equal(rows[1].content, '近问')
  db.close()
})

test('崩溃兜底：重新 initChatTables 把遗留 generating 翻成 error', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  appendMessage('u1', c1, { role: 'assistant', content: '半截', status: 'generating' })
  initChatTables(db)
  assert.equal(getMessages(c1)[0].status, 'error')
  db.close()
})

test('updateMessageContent / markErrorIfGenerating 仍工作', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const { id } = appendMessage('u1', c1, { role: 'assistant', content: '', status: 'generating' })
  updateMessageContent(id, '完整答案', 'done')
  assert.equal(getMessages(c1)[0].content, '完整答案')
  markErrorIfGenerating(id, 'fallback') // 已 done → no-op
  assert.equal(getMessages(c1)[0].status, 'done')
  db.close()
})

test('backfill：旧的无 conversation_id 消息启动时归入每用户一条会话', () => {
  // 先用底层 API 造"遗留"数据：直接建旧结构的行。
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, seq INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done',
      pinned INTEGER, compacted_count INTEGER, compacted_at INTEGER, created_at TEXT NOT NULL
    );
  `)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO chat_messages (id, user_id, seq, role, content, status, created_at)
    VALUES ('m1','u1',1,'user','你好','done',?)`).run(now)
  db.prepare(`INSERT INTO chat_messages (id, user_id, seq, role, content, status, created_at)
    VALUES ('m2','u1',2,'assistant','你好呀','done',?)`).run(now)
  initChatTables(db) // 触发迁移 + backfill
  const list = listConversations('u1')
  assert.equal(list.length, 1)
  assert.equal(list[0].message_count, 2)
  assert.equal(list[0].title, '你好') // 取首条 user 消息
  assert.equal(getMessages(list[0].id).length, 2)
  db.close()
})
