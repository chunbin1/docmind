import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true'

const { initChatTables, createConversation, appendMessage, getMessages } = await import('../services/chatStore.js')
const { chatRoutes } = await import('./chat.js')

async function buildApp() {
  const db = new Database(':memory:')
  initChatTables(db)
  const app = Fastify()
  await app.register(cookie, { secret: 'test-secret-test-secret-test-secret' })
  await app.register(chatRoutes, { prefix: '/api' })
  return { app, db }
}

test('同一会话已有 generating 时再发 stream 返回 409', async () => {
  const { app, db } = await buildApp()
  const c = createConversation('dev').id
  appendMessage('dev', c, { role: 'assistant', content: '', status: 'generating' })
  const res = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    payload: { conversationId: c, message: '新问题' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(getMessages(c).filter(m => m.role === 'user').length, 0)
  await app.close(); db.close()
})

test('stream 缺 conversationId → 400', async () => {
  const { app, db } = await buildApp()
  const res = await app.inject({
    method: 'POST', url: '/api/chat/stream', payload: { message: 'x' },
  })
  assert.equal(res.statusCode, 400)
  await app.close(); db.close()
})

test('stream 越权会话 → 404', async () => {
  const { app, db } = await buildApp()
  const other = createConversation('someone-else').id
  const res = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    payload: { conversationId: other, message: 'x' },
  })
  assert.equal(res.statusCode, 404)
  await app.close(); db.close()
})
