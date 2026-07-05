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

test('已有 generating 时再发 stream 返回 409', async () => {
  const { app, db } = await buildApp()
  appendMessage('dev', { role: 'assistant', content: '', status: 'generating' })
  const res = await app.inject({
    method: 'POST', url: '/api/chat/stream', payload: { message: '新问题' },
  })
  assert.equal(res.statusCode, 409)
  // 不应写入新消息
  assert.equal(getMessages('dev').filter(m => m.role === 'user').length, 0)
  await app.close(); db.close()
})
