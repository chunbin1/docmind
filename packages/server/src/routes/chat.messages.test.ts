import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true' // currentUser 返回 dev 用户(id='dev')

// NOTE: chatStore.js / chat.js (which transitively imports auth.js) must be loaded
// via dynamic import() *after* the env assignment above. ESM hoists static `import`
// statements above all other top-level code in a file, so a static import here would
// evaluate auth.ts's module-level `AUTH_DISABLED` constant before the assignment runs,
// making currentUser() always return null regardless of source-line order.
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

test('GET /api/chat/messages 按 seq 返回并映射 error→isError', async () => {
  const { app, db } = await buildApp()
  appendMessage('dev', { role: 'user', content: '问' })
  appendMessage('dev', { role: 'assistant', content: '答', status: 'done' })
  appendMessage('dev', { role: 'assistant', content: '坏', status: 'error' })
  const res = await app.inject({ method: 'GET', url: '/api/chat/messages' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { messages: Array<{ role: string; content: string; isError?: boolean }> }
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[0].content, '问')
  assert.equal(body.messages[2].isError, true)
  await app.close(); db.close()
})

test('PATCH /api/chat/messages/:id 改 pinned', async () => {
  const { app, db } = await buildApp()
  const { id } = appendMessage('dev', { role: 'user', content: '记住' })
  const res = await app.inject({
    method: 'PATCH', url: `/api/chat/messages/${id}`,
    payload: { pinned: true },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(getMessages('dev')[0].pinned, 1)
  await app.close(); db.close()
})

test('DELETE /api/chat/messages 清空', async () => {
  const { app, db } = await buildApp()
  appendMessage('dev', { role: 'user', content: 'x' })
  const res = await app.inject({ method: 'DELETE', url: '/api/chat/messages' })
  assert.equal(res.statusCode, 200)
  assert.equal(getMessages('dev').length, 0)
  await app.close(); db.close()
})
