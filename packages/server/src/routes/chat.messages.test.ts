import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true' // currentUser 返回 dev 用户(id='dev')

const { initChatTables, createConversation, appendMessage, getMessages, listConversations, getConversation } = await import('../services/chatStore.js')
const { chatRoutes } = await import('./chat.js')

async function buildApp() {
  const db = new Database(':memory:')
  initChatTables(db)
  const app = Fastify()
  await app.register(cookie, { secret: 'test-secret-test-secret-test-secret' })
  await app.register(chatRoutes, { prefix: '/api' })
  return { app, db }
}

test('POST /api/chat/conversations 建会话并返回 id', async () => {
  const { app, db } = await buildApp()
  const res = await app.inject({ method: 'POST', url: '/api/chat/conversations' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { id: string }
  assert.ok(body.id)
  assert.equal(getConversation(body.id)?.user_id, 'dev')
  await app.close(); db.close()
})

test('GET /api/chat/conversations 列出本用户会话', async () => {
  const { app, db } = await buildApp()
  createConversation('dev')
  const res = await app.inject({ method: 'GET', url: '/api/chat/conversations' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { conversations: Array<{ id: string }> }
  assert.equal(body.conversations.length, 1)
  await app.close(); db.close()
})

test('GET /api/chat/messages 需 conversationId，按 seq 返回并映射 error→isError', async () => {
  const { app, db } = await buildApp()
  const c = createConversation('dev').id
  appendMessage('dev', c, { role: 'user', content: '问' })
  appendMessage('dev', c, { role: 'assistant', content: '答', status: 'done' })
  appendMessage('dev', c, { role: 'assistant', content: '坏', status: 'error' })
  const res = await app.inject({ method: 'GET', url: `/api/chat/messages?conversationId=${c}` })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { messages: Array<{ content: string; isError?: boolean }> }
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[0].content, '问')
  assert.equal(body.messages[2].isError, true)
  await app.close(); db.close()
})

test('GET /api/chat/messages 缺 conversationId → 400', async () => {
  const { app, db } = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/api/chat/messages' })
  assert.equal(res.statusCode, 400)
  await app.close(); db.close()
})

test('GET /api/chat/messages 越权会话 → 404', async () => {
  const { app, db } = await buildApp()
  const other = createConversation('someone-else').id
  const res = await app.inject({ method: 'GET', url: `/api/chat/messages?conversationId=${other}` })
  assert.equal(res.statusCode, 404)
  await app.close(); db.close()
})

test('DELETE /api/chat/conversations/:id 删会话及消息', async () => {
  const { app, db } = await buildApp()
  const c = createConversation('dev').id
  appendMessage('dev', c, { role: 'user', content: 'x' })
  const res = await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${c}` })
  assert.equal(res.statusCode, 200)
  assert.equal(listConversations('dev').length, 0)
  assert.equal(getMessages(c).length, 0)
  await app.close(); db.close()
})

test('DELETE /api/chat/conversations/:id 越权 → 404', async () => {
  const { app, db } = await buildApp()
  const other = createConversation('someone-else').id
  const res = await app.inject({ method: 'DELETE', url: `/api/chat/conversations/${other}` })
  assert.equal(res.statusCode, 404)
  await app.close(); db.close()
})
