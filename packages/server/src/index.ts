// packages/server/src/index.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import cookie from '@fastify/cookie'
import { randomBytes } from 'node:crypto'
import 'dotenv/config'

import { chatRoutes } from './routes/chat.js'
import { documentRoutes } from './routes/documents.js'
import { memoryRoutes } from './routes/memory.js'
import { evalRoutes } from './routes/eval.js'
import { authRoutes } from './routes/auth.js'
import { initDb } from './services/memoryStore.js'
import { initCollection } from './services/memoryVector.js'
import { initDocumentTables } from './services/documentStore.js'
import { initDocCollection } from './services/documentVector.js'
import { initEvalTables } from './services/evalStore.js'
import { initUserTables } from './services/userStore.js'

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
})

await app.register(cors, {
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:4173'],
  credentials: true,
})

await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024 },
})

// Signed cookies back the GitHub login session. Set COOKIE_SECRET so sessions
// survive restarts; otherwise a random per-boot secret is used (logs out users on restart).
const cookieSecret = process.env.COOKIE_SECRET
if (!cookieSecret) {
  app.log.warn('COOKIE_SECRET not set — using a random secret; sessions will reset on restart')
}
await app.register(cookie, {
  secret: cookieSecret || randomBytes(32).toString('hex'),
})

const sqliteDb = initDb()
initDocumentTables(sqliteDb)
initEvalTables(sqliteDb)
initUserTables(sqliteDb)
await initCollection()
await initDocCollection()

await app.register(authRoutes, { prefix: '/api' })
await app.register(chatRoutes, { prefix: '/api' })
await app.register(documentRoutes, { prefix: '/api' })
await app.register(memoryRoutes, { prefix: '/api' })
await app.register(evalRoutes, { prefix: '/api' })

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

const port = Number(process.env.PORT) || 3001

try {
  await app.listen({ port, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
