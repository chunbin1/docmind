import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true' // currentUser 返回 dev 用户(id='dev')

// NOTE: chatStore.js / chat.js (which transitively imports auth.js) must be loaded
// via dynamic import() *after* the env assignment above. See chat.messages.test.ts.
const { initChatTables, appendMessage, getMessages } = await import('../services/chatStore.js')
const { chatRoutes } = await import('./chat.js')

async function buildApp() {
  const db = new Database(':memory:')
  initChatTables(db)
  const app = Fastify()
  await app.register(cookie, { secret: 'test-secret-test-secret-test-secret' })
  await app.register(chatRoutes, { prefix: '/api' })
  return { app, db }
}

test('POST /chat/compact 用空 ids 时不改动对话（边界短路）', async () => {
  const { app, db } = await buildApp()
  appendMessage('dev', { role: 'user', content: '只此一条' })
  const res = await app.inject({ method: 'POST', url: '/api/chat/compact', payload: { ids: [] } })
  assert.equal(res.statusCode, 400)
  assert.equal(getMessages('dev').length, 1)
  await app.close(); db.close()
})
