# 服务端对话持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让聊天历史与"生成中的回答"存到服务端 DB,回答生成不依赖浏览器连接,刷新后前端从服务器拉、未答完则轮询补齐。

**Architecture:** 新增 `chat_messages` 表 + `chatStore` 存储层;新增 `streamAndPersist` 把 LLM 流消费到底(客户端断开也继续)并落库;`/chat/stream` 改为落库 + 断开续跑,新增 GET/PATCH/DELETE messages;`useChat` 改为以服务端为准 + 乐观追加 + 轮询恢复,移除 localStorage。

**Tech Stack:** Fastify + better-sqlite3(服务端,ESM + NodeNext,`.js` 后缀 import),React 19 + Vite(前端);测试:服务端 `node:test` + tsx,前端 vitest + happy-dom。

**设计文档:** `docs/superpowers/specs/2026-07-05-server-side-chat-persistence-design.md`

## Global Constraints

- 服务端 ESM,import 必须带 `.js` 后缀(`moduleResolution: NodeNext`)。
- 前端 import 不带扩展名(Vite bundler 解析)。
- 存储层沿用 `documentStore.ts` 模式:模块级 `_db`,`initXxxTables(db)` 注入,`db()` 访问器。
- 每用户单对话,所有查询按 `user_id` 隔离。
- SQLite 用共享的 `memory.db`(`initDb()` 返回的连接),测试用 `new Database(':memory:')`。
- 服务端类型检查:`cd packages/server && pnpm exec tsc --noEmit`;前端:`cd packages/client && pnpm exec tsc --noEmit`。
- 分支:`feature/server-side-chat-persistence`(已从 master 创建)。

---

### Task 1: chatStore 基础(表 + append/get/update/hasGenerating + 崩溃兜底)

**Files:**
- Create: `packages/server/src/services/chatStore.ts`
- Test: `packages/server/src/services/chatStore.test.ts`

**Interfaces:**
- Produces:
  - `type ChatRole = 'user' | 'assistant' | 'summary'`
  - `type ChatStatus = 'generating' | 'done' | 'error'`
  - `interface ChatMessageRow { id: string; user_id: string; seq: number; role: ChatRole; content: string; status: ChatStatus; pinned: number | null; compacted_count: number | null; compacted_at: number | null; created_at: string }`
  - `interface AppendInput { role: ChatRole; content: string; status?: ChatStatus; pinned?: boolean; compactedCount?: number; compactedAt?: number }`
  - `initChatTables(db: DB): void`
  - `appendMessage(userId: string, m: AppendInput): { id: string; seq: number }`
  - `getMessages(userId: string): ChatMessageRow[]`
  - `updateMessageContent(id: string, content: string, status: ChatStatus): void`
  - `hasGenerating(userId: string): boolean`

- [ ] **Step 1: 写失败测试**

`packages/server/src/services/chatStore.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatStore.test.ts`
Expected: FAIL —— 无法从 `./chatStore.js` 导入(模块不存在)。

- [ ] **Step 3: 实现 chatStore.ts**

`packages/server/src/services/chatStore.ts`:

```ts
// packages/server/src/services/chatStore.ts
import type { DB } from './memoryStore.js'

export type ChatRole = 'user' | 'assistant' | 'summary'
export type ChatStatus = 'generating' | 'done' | 'error'

export interface ChatMessageRow {
  id: string
  user_id: string
  seq: number
  role: ChatRole
  content: string
  status: ChatStatus
  pinned: number | null
  compacted_count: number | null
  compacted_at: number | null
  created_at: string
}

export interface AppendInput {
  role: ChatRole
  content: string
  status?: ChatStatus
  pinned?: boolean
  compactedCount?: number
  compactedAt?: number
}

let _db: DB | null = null

export function initChatTables(db: DB): void {
  _db = db
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'done',
      pinned          INTEGER,
      compacted_count INTEGER,
      compacted_at    INTEGER,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_user_seq ON chat_messages(user_id, seq);
  `)
  // Crash recovery: no in-flight generation survives a process restart, so any
  // lingering 'generating' row is stale — mark it errored so clients stop polling.
  db.prepare("UPDATE chat_messages SET status='error' WHERE status='generating'").run()
}

function db(): DB {
  if (!_db) throw new Error('chatStore not initialized — call initChatTables() first')
  return _db
}

function genId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export function appendMessage(userId: string, m: AppendInput): { id: string; seq: number } {
  const id = genId()
  const { next } = db()
    .prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM chat_messages WHERE user_id = ?')
    .get(userId) as { next: number }
  db().prepare(`
    INSERT INTO chat_messages
      (id, user_id, seq, role, content, status, pinned, compacted_count, compacted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, next, m.role, m.content, m.status ?? 'done',
    m.pinned ? 1 : null, m.compactedCount ?? null, m.compactedAt ?? null,
    new Date().toISOString(),
  )
  return { id, seq: next }
}

export function getMessages(userId: string): ChatMessageRow[] {
  return db()
    .prepare('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY seq ASC')
    .all(userId) as ChatMessageRow[]
}

export function updateMessageContent(id: string, content: string, status: ChatStatus): void {
  db().prepare('UPDATE chat_messages SET content = ?, status = ? WHERE id = ?').run(content, status, id)
}

export function hasGenerating(userId: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM chat_messages WHERE user_id = ? AND status = 'generating' LIMIT 1")
    .get(userId)
  return !!row
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatStore.test.ts`
Expected: PASS(5 个测试全过)。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/chatStore.ts packages/server/src/services/chatStore.test.ts
git commit -m "feat(chat): chatStore 基础存储层 + 崩溃兜底"
```

---

### Task 2: chatStore 变更方法(setPinned / clearMessages / replaceForCompaction)

**Files:**
- Modify: `packages/server/src/services/chatStore.ts`
- Modify: `packages/server/src/services/chatStore.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `appendMessage`, `getMessages`。
- Produces:
  - `setPinned(userId: string, id: string, pinned: boolean): void`
  - `clearMessages(userId: string): void`
  - `replaceForCompaction(userId: string, deleteIds: string[], summary: string): void`

- [ ] **Step 1: 追加失败测试**

在 `chatStore.test.ts` 顶部 import 补上新函数:

```ts
import {
  initChatTables, appendMessage, getMessages, updateMessageContent, hasGenerating,
  setPinned, clearMessages, replaceForCompaction,
} from './chatStore.js'
```

文件末尾追加:

```ts
test('setPinned 只改本用户消息的 pinned', () => {
  const db = setup()
  const { id } = appendMessage('u1', { role: 'user', content: 'x' })
  setPinned('u1', id, true)
  assert.equal(getMessages('u1')[0].pinned, 1)
  setPinned('u1', id, false)
  assert.equal(getMessages('u1')[0].pinned, null)
  db.close()
})

test('clearMessages 只清空本用户', () => {
  const db = setup()
  appendMessage('u1', { role: 'user', content: 'a' })
  appendMessage('u2', { role: 'user', content: 'b' })
  clearMessages('u1')
  assert.equal(getMessages('u1').length, 0)
  assert.equal(getMessages('u2').length, 1)
  db.close()
})

test('replaceForCompaction 删旧行并头插 summary（排在最前）', () => {
  const db = setup()
  const a = appendMessage('u1', { role: 'user', content: '旧问1' })
  const b = appendMessage('u1', { role: 'assistant', content: '旧答1' })
  appendMessage('u1', { role: 'user', content: '近问' })
  replaceForCompaction('u1', [a.id, b.id], '这是摘要')
  const rows = getMessages('u1')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].role, 'summary')
  assert.equal(rows[0].content, '这是摘要')
  assert.equal(rows[0].compacted_count, 2)
  assert.equal(rows[1].content, '近问')
  db.close()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatStore.test.ts`
Expected: FAIL —— `setPinned`/`clearMessages`/`replaceForCompaction` 未导出。

- [ ] **Step 3: 在 chatStore.ts 末尾追加实现**

```ts
export function setPinned(userId: string, id: string, pinned: boolean): void {
  db().prepare('UPDATE chat_messages SET pinned = ? WHERE id = ? AND user_id = ?')
    .run(pinned ? 1 : null, id, userId)
}

export function clearMessages(userId: string): void {
  db().prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId)
}

export function replaceForCompaction(userId: string, deleteIds: string[], summary: string): void {
  const tx = db().transaction(() => {
    const del = db().prepare('DELETE FROM chat_messages WHERE id = ? AND user_id = ?')
    for (const id of deleteIds) del.run(id, userId)
    // Summary becomes the earliest message: one below the current min seq.
    const { prev } = db()
      .prepare('SELECT COALESCE(MIN(seq),1)-1 AS prev FROM chat_messages WHERE user_id = ?')
      .get(userId) as { prev: number }
    db().prepare(`
      INSERT INTO chat_messages
        (id, user_id, seq, role, content, status, pinned, compacted_count, compacted_at, created_at)
      VALUES (?, ?, ?, 'summary', ?, 'done', NULL, ?, ?, ?)
    `).run(genId(), userId, prev, summary, deleteIds.length, Date.now(), new Date().toISOString())
  })
  tx()
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatStore.test.ts`
Expected: PASS(8 个测试)。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/chatStore.ts packages/server/src/services/chatStore.test.ts
git commit -m "feat(chat): chatStore pin/clear/压缩替换"
```

---

### Task 3: streamAndPersist(断开续跑的生成核心)

**Files:**
- Create: `packages/server/src/services/chatGeneration.ts`
- Test: `packages/server/src/services/chatGeneration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `updateMessageContent`；测试用 `initChatTables`/`appendMessage`/`getMessages`。
- Produces:
  - `interface StreamAndPersistOpts { assistantId: string; stream: AsyncIterable<string>; send: (text: string) => void }`
  - `streamAndPersist(opts: StreamAndPersistOpts): Promise<string>`

- [ ] **Step 1: 写失败测试**

`packages/server/src/services/chatGeneration.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initChatTables, appendMessage, getMessages } from './chatStore.js'
import { streamAndPersist } from './chatGeneration.js'

function setup() {
  const db = new Database(':memory:')
  initChatTables(db)
  return db
}

async function* gen(chunks: string[]) {
  for (const c of chunks) yield c
}

test('客户端断开（send 抛错）仍把答案生成完并落库 done', async () => {
  const db = setup()
  const { id } = appendMessage('u1', { role: 'assistant', content: '', status: 'generating' })
  let calls = 0
  const send = () => { calls++; if (calls === 1) throw new Error('socket closed') }
  const out = await streamAndPersist({ assistantId: id, stream: gen(['a', 'b', 'c']), send })
  assert.equal(out, 'abc')
  const row = getMessages('u1')[0]
  assert.equal(row.content, 'abc')
  assert.equal(row.status, 'done')
  db.close()
})

test('流抛错时落库 status=error 并向上抛', async () => {
  const db = setup()
  const { id } = appendMessage('u1', { role: 'assistant', content: '', status: 'generating' })
  async function* boom() { yield 'a'; throw new Error('llm boom') }
  await assert.rejects(streamAndPersist({ assistantId: id, stream: boom(), send: () => {} }))
  assert.equal(getMessages('u1')[0].status, 'error')
  db.close()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatGeneration.test.ts`
Expected: FAIL —— 无法导入 `streamAndPersist`。

- [ ] **Step 3: 实现 chatGeneration.ts**

```ts
// packages/server/src/services/chatGeneration.ts
import { updateMessageContent } from './chatStore.js'

export interface StreamAndPersistOpts {
  assistantId: string
  stream: AsyncIterable<string>
  /** Push one chunk to the client; may throw if the socket is already closed. */
  send: (text: string) => void
}

/**
 * Consume the LLM stream to completion regardless of whether the client is
 * still connected, persisting the accumulated answer. `send()` failures (closed
 * socket) are swallowed so generation keeps running server-side. Returns the
 * full text; on stream error persists status='error' and rethrows.
 */
export async function streamAndPersist(opts: StreamAndPersistOpts): Promise<string> {
  let out = ''
  try {
    for await (const text of opts.stream) {
      out += text
      try { opts.send(text) } catch { /* client gone — keep generating */ }
    }
    updateMessageContent(opts.assistantId, out, 'done')
    return out
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateMessageContent(opts.assistantId, out || `出错了：${msg}`, 'error')
    throw err
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatGeneration.test.ts`
Expected: PASS(2 个测试)。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/chatGeneration.ts packages/server/src/services/chatGeneration.test.ts
git commit -m "feat(chat): streamAndPersist 断开续跑生成核心"
```

---

### Task 4: 装配 index.ts + GET/PATCH/DELETE messages 路由 + 路由测试

**Files:**
- Modify: `packages/server/src/index.ts:21`(import)与 `:55`(init 调用)
- Modify: `packages/server/src/routes/chat.ts`(新增三个路由 + rowToChatMessage 映射)
- Test: `packages/server/src/routes/chat.messages.test.ts`

**Interfaces:**
- Consumes: `chatStore` 的 `getMessages`/`setPinned`/`clearMessages`；`currentUser`。
- Produces:
  - `GET /api/chat/messages` → `{ messages: ClientChatMessage[] }`
  - `PATCH /api/chat/messages/:id` body `{ pinned: boolean }` → `{ ok: true }`
  - `DELETE /api/chat/messages` → `{ ok: true }`
  - 内部辅助 `rowToChatMessage(row: ChatMessageRow): ClientChatMessage`,其中
    `interface ClientChatMessage { id: string; role: ChatRole; content: string; pinned?: boolean; isError?: boolean; status: ChatStatus; compactedCount?: number; compactedAt?: number }`

- [ ] **Step 1: 写失败测试(用 AUTH_DISABLED + 内存库 + app.inject)**

`packages/server/src/routes/chat.messages.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true' // currentUser 返回 dev 用户(id='dev')

import { initChatTables, appendMessage, getMessages } from '../services/chatStore.js'
import { chatRoutes } from './chat.js'

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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.messages.test.ts`
Expected: FAIL —— 路由不存在,GET 返回 404。

- [ ] **Step 3a: 装配 index.ts**

在 `packages/server/src/index.ts` 的 import 区(第 21 行 `initTraceTables` 后)加:

```ts
import { initChatTables } from './services/chatStore.js'
```

在 init 区(第 55 行 `initTraceTables(sqliteDb)` 后)加:

```ts
initChatTables(sqliteDb)
```

- [ ] **Step 3b: 在 chat.ts 顶部补 import 与映射辅助**

在 `packages/server/src/routes/chat.ts` 顶部 import 区补:

```ts
import {
  getMessages, appendMessage, updateMessageContent, hasGenerating,
  setPinned, clearMessages, replaceForCompaction,
  type ChatMessageRow, type ChatRole, type ChatStatus,
} from '../services/chatStore.js'
```

在 `DEFAULT_SYSTEM` 常量附近加映射函数与类型:

```ts
interface ClientChatMessage {
  id: string
  role: ChatRole
  content: string
  pinned?: boolean
  isError?: boolean
  status: ChatStatus
  compactedCount?: number
  compactedAt?: number
}

function rowToChatMessage(row: ChatMessageRow): ClientChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    pinned: row.pinned ? true : undefined,
    isError: row.status === 'error' ? true : undefined,
    status: row.status,
    compactedCount: row.compacted_count ?? undefined,
    compactedAt: row.compacted_at ?? undefined,
  }
}
```

- [ ] **Step 3c: 在 chatRoutes 内(`app.get('/health'...)` 之后)新增三个路由**

```ts
app.get('/chat/messages', async (request, reply) => {
  const user = currentUser(request)
  if (!user) return reply.status(401).send({ error: 'unauthorized' })
  return { messages: getMessages(user.id).map(rowToChatMessage) }
})

app.patch<{ Params: { id: string }; Body: { pinned: boolean } }>(
  '/chat/messages/:id',
  async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    setPinned(user.id, request.params.id, !!request.body?.pinned)
    return { ok: true }
  },
)

app.delete('/chat/messages', async (request, reply) => {
  const user = currentUser(request)
  if (!user) return reply.status(401).send({ error: 'unauthorized' })
  clearMessages(user.id)
  return { ok: true }
})
```

> 注:`appendMessage`/`updateMessageContent`/`hasGenerating`/`replaceForCompaction` 在本任务只 import 不用会触发 `noUnusedLocals`?本仓库 tsconfig 未开该项(其余文件有类似用法)。若报未使用,把它们的 import 挪到 Task 5/6 再加。先跑 tsc 验证。

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.messages.test.ts && pnpm exec tsc --noEmit`
Expected: PASS(3 个测试),tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/index.ts packages/server/src/routes/chat.ts packages/server/src/routes/chat.messages.test.ts
git commit -m "feat(chat): 装配 chatStore + GET/PATCH/DELETE messages 路由"
```

---

### Task 5: 改造 `/chat/stream`(落库 + 断开续跑 + 409 + 历史改由 DB 读 + 服务端自动 pin)

**Files:**
- Modify: `packages/server/src/routes/chat.ts`(`/chat/stream` handler,约 199-295 行)
- Modify: `packages/server/src/routes/chat.ts`(`StreamBody` 类型,约 176-181 行)

**Interfaces:**
- Consumes: Task 1-3 的 `appendMessage`/`getMessages`/`hasGenerating`、`streamAndPersist`;现有 `trimHistoryByTokens`/`getRelevantNotes`/`getRelevantChunks`/`runToolsIfNeeded`/`streamChat`。
- Produces:请求体收敛为 `interface StreamBody { message: string; docIds?: string[] }`(去掉 `history`/`systemPrompt`);行为见步骤。

- [ ] **Step 1: 写失败测试(落库 + 409)**

`packages/server/src/routes/chat.stream.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true'

import { initChatTables, appendMessage, getMessages } from '../services/chatStore.js'
import { chatRoutes } from './chat.js'

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
```

> 完整的"发一句 → 落库 user(done)+assistant(done)"端到端会真调 LLM,不在单测覆盖(见 §7 真实数据手测);断开续跑已由 Task 3 的 `streamAndPersist` 单测守住。本步只测 409 短路(在真正调用 LLM 之前返回)。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.stream.test.ts`
Expected: FAIL —— 当前 stream 无 409 逻辑,会走到 LLM(报错或非 409)。

- [ ] **Step 3a: 收敛 StreamBody 类型**

把 `StreamBody` 改为:

```ts
interface StreamBody {
  message: string
  docIds?: string[]
}
```

在 `DEFAULT_SYSTEM` 附近补自动 pin 关键词(从前端迁移过来):

```ts
const PIN_KEYWORDS = [
  '记住这个', '记住', '重要', '不要忘记', '关键信息', 'remember this', 'important',
]
function isAutoPinned(message: string): boolean {
  const lower = message.toLowerCase()
  return PIN_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
}
```

- [ ] **Step 3b: 重写 `/chat/stream` handler 主体**

把 `app.post<{ Body: StreamBody }>('/chat/stream', ...)` 的实现替换为下述结构(保留原有 trace span 包裹与记忆/文档/工具并行逻辑,仅改动:history 来源、落库、streamAndPersist):

```ts
app.post<{ Body: StreamBody }>('/chat/stream', async (request, reply) => {
  const user = currentUser(request)
  if (!user) return reply.status(401).send({ error: 'unauthorized' })
  if (!canSend(user)) {
    return reply.status(403).send({
      error: 'message_limit_reached', limit: MESSAGE_LIMIT, used: user.message_count,
    })
  }
  const { message, docIds = [] } = request.body
  if (!message?.trim()) return reply.status(400).send({ error: 'message is required' })

  // 单用户单对话：上一条还在生成时拒绝并发。
  if (hasGenerating(user.id)) {
    return reply.status(409).send({ error: 'generating_in_progress' })
  }

  incrementMessageCount(user.id)

  // 历史以 DB 为准（不再信任前端 body）。
  const prior = getMessages(user.id)
  const summaryRow = prior.find(m => m.role === 'summary')
  const history: LLMMessage[] = prior
    .filter(m => m.role !== 'summary')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, pinned: !!m.pinned }))

  // 落库本轮 user + assistant 占位。
  appendMessage(user.id, { role: 'user', content: message, pinned: isAutoPinned(message) })
  const asst = appendMessage(user.id, { role: 'assistant', content: '', status: 'generating' })

  try {
    await runInTrace({ route: '/chat/stream', userId: user.id }, async () => {
      const [relevantNotes, relevantChunks, toolSection] = await Promise.all([
        withSpan('memory_retrieval', async () => {
          spanInput(message)
          const notes = await getRelevantNotes(user.id, message)
          spanOutput(notes.map(n => n.content).join('\n'))
          return notes
        }),
        withSpan('doc_retrieval', async () => {
          spanInput(message)
          const chunks = await getRelevantChunks(user.id, message, docIds)
          spanOutput(chunks.map(c => `[${c.filename}·块${c.chunk_index}] ${c.content}`).join('\n'))
          return chunks
        }),
        withSpan('tool_preflight', () => runToolsIfNeeded(message, history)),
      ])

      const finalSystem = await withSpan('prompt_assembly', async () => {
        const memSection = relevantNotes.length
          ? `--- 相关记忆 ---\n${relevantNotes.map(n => `- ${n.content}`).join('\n')}` : ''
        const docSection = relevantChunks.length
          ? `--- 文档参考 ---\n${relevantChunks.map(c => `[${c.filename} · 块${c.chunk_index}] ${c.content}`).join('\n')}` : ''
        const summarySection = summaryRow
          ? `--- 早期对话摘要 ---\n${summaryRow.content}` : ''
        const trimmed = trimHistoryByTokens(history)
        if (trimmed.length < history.length) {
          markDegraded('history_trimmed', { dropped: history.length - trimmed.length })
        }
        const finalSystem = [DEFAULT_SYSTEM, summarySection, memSection, docSection, toolSection]
          .filter(Boolean).join('\n\n')
        spanMeta('finalTokens', estimateTokens(finalSystem))
        return finalSystem
      })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const trySend = (payload: SSEPayload): void => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const llmMessages: LLMMessage[] = [
        ...trimHistoryByTokens(history),
        { role: 'user', content: message },
      ]

      await withSpan('llm_generation', async () => {
        spanMeta('provider', PROVIDER)
        const t0 = performance.now()
        let firstAt = 0
        try {
          const stream = streamChat({ messages: llmMessages, system: finalSystem, tag: 'chat/stream' })
          const wrapped = (async function* () {
            for await (const text of stream) {
              if (!firstAt) { firstAt = performance.now(); spanMeta('ttfbMs', Math.round(firstAt - t0)) }
              yield text
            }
          })()
          const out = await streamAndPersist({
            assistantId: asst.id,
            stream: wrapped,
            send: (text) => trySend({ text }),
          })
          spanOutput(out)
          spanMeta('outputTokens', estimateTokens(out))
          try { trySend({ done: true }) } catch { /* client gone */ }
        } catch (err) {
          app.log.error(err)
          try { trySend({ error: err instanceof Error ? err.message : 'Unknown error' }) } catch { /* client gone */ }
          throw err
        } finally {
          try { reply.raw.end() } catch { /* already ended */ }
        }
      })
    })
  } catch {
    // 错误已通过 SSE 告知客户端 + 落库 status=error（streamAndPersist）+ 记入 trace。
  }
})
```

> 说明:配额 401/403 分支保留;移除了原来读取 `history`/`systemPrompt`/`finalSystemPrompt` 的逻辑。`send` 的 try/catch 由 `streamAndPersist` 内部兜底,`trySend({done/error})` 外面再包一层防止 socket 已关。

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.stream.test.ts && pnpm exec tsc --noEmit`
Expected: PASS(409 测试),tsc 无输出。同时跑 `pnpm exec tsx --test src/routes/chat.messages.test.ts` 确认未回归。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/chat.ts packages/server/src/routes/chat.stream.test.ts
git commit -m "feat(chat): /chat/stream 落库+断开续跑+409+历史改由DB读"
```

---

### Task 6: 改造 `/chat/compact`(按 id 摘要 + 替换落库)

**Files:**
- Modify: `packages/server/src/routes/chat.ts`(`/chat/compact` handler,约 297-328 行;`CompactBody` 类型)

**Interfaces:**
- Consumes: `getMessages`/`replaceForCompaction`;现有 `streamChat`/`parseCompactOutput`/`persistFacts`。
- Produces:请求体改为 `interface CompactBody { ids: string[] }`;返回 `{ summary: string }`(不变),副作用:删除这些 id 的行、头插 summary 行、抽取事实入记忆。

- [ ] **Step 1: 写失败测试**

`packages/server/src/routes/chat.compact.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

process.env.AUTH_DISABLED = 'true'

import { initChatTables, appendMessage, getMessages } from '../services/chatStore.js'
import { chatRoutes } from './chat.js'

test('POST /chat/compact 用空 ids 时不改动对话（边界短路）', async () => {
  const db = new Database(':memory:')
  initChatTables(db)
  const app = Fastify()
  await app.register(cookie, { secret: 'test-secret-test-secret-test-secret' })
  await app.register(chatRoutes, { prefix: '/api' })
  appendMessage('dev', { role: 'user', content: '只此一条' })
  const res = await app.inject({ method: 'POST', url: '/api/chat/compact', payload: { ids: [] } })
  assert.equal(res.statusCode, 400)
  assert.equal(getMessages('dev').length, 1)
  await app.close(); db.close()
})
```

> 真正调用 LLM 的摘要路径走手测(需 provider key);本步只守 `ids` 为空的 400 短路,避免误删。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.compact.test.ts`
Expected: FAIL —— 现有 compact 读 `messages` 而非 `ids`,空 `ids` 不会返回 400。

- [ ] **Step 3: 替换 compact handler**

把 `CompactBody` 改为:

```ts
interface CompactBody {
  ids: string[]
}
```

把 `app.post<{ Body: CompactBody }>('/chat/compact', ...)` 实现改为:

```ts
app.post<{ Body: CompactBody }>('/chat/compact', async (request, reply) => {
  const user = currentUser(request)
  if (!user) return reply.status(401).send({ error: 'unauthorized' })
  const { ids } = request.body
  if (!Array.isArray(ids) || ids.length === 0) {
    return reply.status(400).send({ error: 'ids is required' })
  }

  const byId = new Map(getMessages(user.id).map(m => [m.id, m]))
  const targets = ids.map(id => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m)
  if (targets.length === 0) return reply.status(400).send({ error: 'no matching messages' })

  return runInTrace({ route: '/chat/compact', userId: user.id }, async () => {
    const historyText = targets
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n')

    let rawOutput = ''
    await withSpan('summarize', async () => {
      const stream = streamChat({
        messages: [{ role: 'user', content: `请分析以下对话，完成两项任务：\n\n1. 生成对话摘要（300字以内，保留关键信息和用户意图）\n2. 提取值得长期记忆的重要事实（最多5条，每条50字以内，每行一条）\n\n请严格按以下格式输出（不要添加其他内容）：\n\n##SUMMARY##\n[摘要内容]\n\n##FACTS##\n[事实1]\n[事实2]\n\n对话内容：\n${historyText}` }],
        system: '你是对话分析助手，专注提炼关键信息和重要事实。',
        maxTokens: 1024,
        tag: 'chat/compact',
      })
      for await (const text of stream) rawOutput += text
      spanOutput(rawOutput)
    })

    const { summary, facts } = parseCompactOutput(rawOutput)
    replaceForCompaction(user.id, targets.map(m => m.id), summary)
    await withSpan('memory_write', async () => {
      if (facts.length > 0) persistFacts(user.id, facts, 'compact')
      spanMeta('facts', facts.length)
    })
    return { summary, facts }
  })
})
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.compact.test.ts && pnpm exec tsc --noEmit`
Expected: PASS,tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/chat.ts packages/server/src/routes/chat.compact.test.ts
git commit -m "feat(chat): /chat/compact 改为按 id 摘要并替换落库"
```

---

### Task 7: 前端测试基座(vitest)

> 若 `packages/client/vitest.config.ts` 已存在(例如 PR #16 已并入 master),跳过本任务。

**Files:**
- Create: `packages/client/vitest.config.ts`
- Modify: `packages/client/package.json`(devDeps + test 脚本)
- Modify: `packages/client/src/lib/waterfall.test.ts:1`、`packages/client/src/lib/statBars.test.ts:1`(import 换 vitest)

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd packages/client && pnpm add -D vitest happy-dom @testing-library/react @testing-library/dom
```

- [ ] **Step 2: 创建 vitest.config.ts**

`packages/client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

- [ ] **Step 3: 改 package.json test 脚本**

把 `"test": "tsx --test src/lib/waterfall.test.ts src/lib/statBars.test.ts"` 改为:

```json
"test": "vitest run"
```

- [ ] **Step 4: 迁移两个 lib 测试的 import**

`src/lib/waterfall.test.ts` 与 `src/lib/statBars.test.ts` 第 1 行 `import { test } from 'node:test'` 改为:

```ts
import { test } from 'vitest'
```

`waterfall.test.ts` 还用了 `assert`——保留 `import assert from 'node:assert/strict'`(vitest 下 node 内置仍可用),不改断言。

- [ ] **Step 5: 运行 + 提交**

Run: `cd packages/client && pnpm test`
Expected: PASS(waterfall + statBars 共 10 个测试)。

```bash
git add packages/client/package.json packages/client/pnpm-lock.yaml ../../pnpm-lock.yaml packages/client/vitest.config.ts packages/client/src/lib/waterfall.test.ts packages/client/src/lib/statBars.test.ts
git commit -m "test(client): 引入 vitest + happy-dom 测试基座"
```

---

### Task 8: 前端类型 + useChat 重写(服务端为准 + 乐观追加 + 轮询恢复)

**Files:**
- Modify: `packages/client/src/types.ts`(`ChatMessage` 加 `id`/`status`;`UseChatReturn` 加 `loading`/`loadError`;`sendMessage` 签名)
- Rewrite: `packages/client/src/hooks/useChat.ts`
- Replace: `packages/client/src/hooks/useChat.test.ts`(若不存在则新建)

**Interfaces:**
- Consumes: 后端 `GET/POST/PATCH/DELETE /api/chat/*`。
- Produces:
  - `ChatMessage` 新增 `id?: string`、`status?: 'generating' | 'done' | 'error'`
  - `UseChatReturn` 新增 `loading: boolean`、`loadError: boolean`;`sendMessage: (message: string, docIds?: string[]) => Promise<void>`
  - `useChat` 内部:首拉 `GET /messages`;末条 `status==='generating'` 时每 1s 轮询(≤2min);发送乐观追加 + SSE;409 回滚。

- [ ] **Step 1: 改 types.ts**

`packages/client/src/types.ts`:

- `ChatMessage` 接口加两行:
```ts
  /** 服务端消息 id（用于 pin/patch） */
  id?: string
  /** 生成状态：generating 表示服务端仍在产出 */
  status?: 'generating' | 'done' | 'error'
```
- `UseChatReturn` 改为:
```ts
export interface UseChatReturn {
  messages: ChatMessage[]
  streaming: boolean
  compacting: boolean
  loading: boolean
  loadError: boolean
  sendMessage: (message: string, docIds?: string[]) => Promise<void>
  stopStreaming: () => void
  clearMessages: () => void
  togglePin: (index: number) => void
}
```

- [ ] **Step 2: 写失败测试**

`packages/client/src/hooks/useChat.test.ts`(整文件):

```ts
import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatMessage } from '../types'

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

afterEach(() => { vi.unstubAllGlobals() })

test('加载：挂载时从 GET /messages 填充', async () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: '你好', status: 'done' },
    { id: 'm2', role: 'assistant', content: '你也好', status: 'done' },
  ]
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ messages })))

  const { result } = renderHook(() => useChat('u1'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.messages.map(m => m.content)).toEqual(['你好', '你也好'])
})

test('轮询恢复：末条 generating → 轮询到 done 后停止并显示完整答案', async () => {
  const gen: ChatMessage[] = [
    { id: 'u', role: 'user', content: '广州天气如何', status: 'done' },
    { id: 'a', role: 'assistant', content: '', status: 'generating' },
  ]
  const done: ChatMessage[] = [
    { id: 'u', role: 'user', content: '广州天气如何', status: 'done' },
    { id: 'a', role: 'assistant', content: '广州今天晴', status: 'done' },
  ]
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1
    return jsonRes({ messages: calls === 1 ? gen : done })
  }))

  const { result } = renderHook(() => useChat('u1'))
  await waitFor(() =>
    expect(result.current.messages.some(m => m.content === '广州今天晴')).toBe(true),
    { timeout: 3000 },
  )
})

test('加载失败：GET 出错时 loadError=true 且消息为空', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
  const { result } = renderHook(() => useChat('u1'))
  await waitFor(() => expect(result.current.loadError).toBe(true))
  expect(result.current.messages).toEqual([])
})
```

- [ ] **Step 3: 运行确认失败**

Run: `cd packages/client && pnpm exec vitest run src/hooks/useChat.test.ts`
Expected: FAIL —— useChat 还是 localStorage 版本,`loading`/`loadError` 未定义、无 GET/轮询。

- [ ] **Step 4: 重写 useChat.ts**

`packages/client/src/hooks/useChat.ts`(整文件):

```ts
import { useState, useRef, useCallback, useEffect } from 'react'
import type { ChatMessage, UseChatReturn } from '../types'

const COMPACT_THRESHOLD = 12000
const COMPACT_KEEP_RECENT = 6
const NUDGE_INTERVAL = 10
const POLL_INTERVAL_MS = 1000
const POLL_MAX_MS = 120000

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3)
}
function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}
function lastIsGenerating(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  return !!last && last.role === 'assistant' && last.status === 'generating'
}

export function useChat(userId: string | null): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const turnCountRef = useRef(0)
  const messagesRef = useRef<ChatMessage[]>(messages)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { messagesRef.current = messages }, [messages])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
  }, [])

  const fetchMessages = useCallback(async (): Promise<ChatMessage[]> => {
    const res = await fetch('/api/chat/messages')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { messages: ChatMessage[] }
    return body.messages
  }, [])

  // 末条 generating 时轮询到 done/error 或超时。
  const startPolling = useCallback((deadline: number) => {
    stopPolling()
    pollTimerRef.current = setTimeout(async () => {
      try {
        const msgs = await fetchMessages()
        setMessages(msgs)
        if (lastIsGenerating(msgs) && Date.now() < deadline) {
          startPolling(deadline)
        } else if (lastIsGenerating(msgs)) {
          // 超时：把末条标记为中断，停止轮询。
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.status === 'generating') {
              updated[updated.length - 1] = { ...last, status: 'error', content: last.content || '回答已中断', isError: true }
            }
            return updated
          })
        }
      } catch {
        // 轮询失败静默重试直到超时
        if (Date.now() < deadline) startPolling(deadline)
      }
    }, POLL_INTERVAL_MS)
  }, [fetchMessages, stopPolling])

  // 加载本账号对话（登出清空）。
  useEffect(() => {
    stopPolling()
    if (!userId) { setMessages([]); setLoadError(false); return }
    let cancelled = false
    setLoading(true); setLoadError(false)
    fetchMessages()
      .then(msgs => {
        if (cancelled) return
        setMessages(msgs)
        if (lastIsGenerating(msgs)) startPolling(Date.now() + POLL_MAX_MS)
      })
      .catch(() => { if (!cancelled) { setMessages([]); setLoadError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; stopPolling() }
  }, [userId, fetchMessages, startPolling, stopPolling])

  const appendToLast = (text: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, content: last.content + text }
      return updated
    })
  }

  const setLastError = (error: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      updated[updated.length - 1] = {
        ...updated[updated.length - 1], content: `出错了：${error}`, isError: true, status: 'error',
      }
      return updated
    })
  }

  const rollbackOptimistic = (): void => {
    // 移除刚追加的一对 user + assistant 占位。
    setMessages(prev => prev.slice(0, -2))
  }

  const triggerNudge = useCallback((): void => {
    const recent = messagesRef.current.filter(m => m.role !== 'summary').slice(-10)
    if (recent.length === 0) return
    fetch('/api/chat/nudge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: recent }),
    })
      .then(res => { if (res.ok) window.dispatchEvent(new CustomEvent('memory:updated')) })
      .catch(() => {})
  }, [])

  const compactIfNeeded = useCallback(async (): Promise<void> => {
    const current = messagesRef.current
    const chat = current.filter(m => m.role !== 'summary')
    if (totalTokens(chat) < COMPACT_THRESHOLD) return
    const old = chat.slice(0, -COMPACT_KEEP_RECENT)
    if (old.length === 0) return
    const ids = old.map(m => m.id).filter((x): x is string => !!x)
    if (ids.length === 0) return

    setCompacting(true)
    try {
      const res = await fetch('/api/chat/compact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) return
      window.dispatchEvent(new CustomEvent('memory:updated'))
      setMessages(await fetchMessages()) // 拉回服务端规范状态
    } catch {
      // 压缩失败保持原样
    } finally {
      setCompacting(false)
    }
  }, [fetchMessages])

  const sendMessage = useCallback(async (
    message: string,
    docIds: string[] = [],
  ): Promise<void> => {
    if (!message.trim() || streaming || lastIsGenerating(messagesRef.current)) return

    await compactIfNeeded()

    setMessages(prev => [
      ...prev,
      { role: 'user', content: message, status: 'done' },
      { role: 'assistant', content: '', status: 'generating' },
    ])
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, docIds }),
        signal: controller.signal,
      })

      if (res.status === 401) {
        setLastError('登录已失效，请重新登录')
        window.dispatchEvent(new CustomEvent('auth:refresh')); return
      }
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { limit?: number }
        setLastError(`已达每位用户 ${body.limit ?? 10} 条消息上限`)
        window.dispatchEvent(new CustomEvent('auth:refresh')); return
      }
      if (res.status === 409) { rollbackOptimistic(); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const json = JSON.parse(line.slice(6)) as { error?: string; text?: string; done?: boolean }
            if (json.error) throw new Error(json.error)
            if (json.text) appendToLast(json.text)
            if (json.done) {
              setMessages(prev => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                if (last && last.role === 'assistant') updated[updated.length - 1] = { ...last, status: 'done' }
                return updated
              })
              window.dispatchEvent(new CustomEvent('auth:refresh'))
              turnCountRef.current += 1
              if (turnCountRef.current % NUDGE_INTERVAL === 0) triggerNudge()
              return
            }
          } catch { /* skip unparseable chunk */ }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') setLastError(err.message)
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [streaming, compactIfNeeded, triggerNudge])

  const stopStreaming = useCallback((): void => { abortRef.current?.abort() }, [])

  const togglePin = useCallback((index: number): void => {
    const target = messagesRef.current[index]
    if (!target?.id) return
    const nextPinned = !target.pinned
    setMessages(prev => prev.map((m, i) => (i === index ? { ...m, pinned: nextPinned } : m)))
    fetch(`/api/chat/messages/${target.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: nextPinned }),
    }).catch(() => {})
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    fetch('/api/chat/messages', { method: 'DELETE' }).catch(() => {})
  }, [])

  return {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming, clearMessages, togglePin,
  }
}
```

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `cd packages/client && pnpm exec vitest run src/hooks/useChat.test.ts && pnpm exec tsc --noEmit`
Expected: PASS(3 个测试);tsc 可能因 ChatView 仍用旧 `sendMessage(msg, undefined, docIds)` 签名报错 —— 下一任务修。若只想本任务绿,先只跑 vitest。

- [ ] **Step 6: 提交**

```bash
git add packages/client/src/types.ts packages/client/src/hooks/useChat.ts packages/client/src/hooks/useChat.test.ts
git commit -m "feat(chat): useChat 改为服务端为准+乐观追加+轮询恢复"
```

---

### Task 9: 前端 UI 接线(loading / loadError / 生成中禁用 + sendMessage 签名)

**Files:**
- Modify: `packages/client/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: Task 8 的 `useChat` 返回(`loading`/`loadError`,新 `sendMessage(message, docIds?)`)。

- [ ] **Step 1: 更新 ChatView 取值与调用**

在 `ChatView.tsx` 中:

1. 解构补 `loading`, `loadError`:
```ts
  const {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming, clearMessages, togglePin,
  } = useChat(user.id)
```

2. `sendMessage` 两处调用去掉 `undefined` 中间参:
- 建议区:`onClick={() => void sendMessage(s)}`(不变,单参已兼容)
- ChatInput:`onSend={(msg, docIds) => void sendMessage(msg, docIds)}`

3. 生成中禁用输入 —— 计算末条是否生成中,并入 `streaming`:
```ts
  const generating = streaming || (messages[messages.length - 1]?.status === 'generating')
```
把 `<ChatInput ... streaming={streaming || compacting} .../>` 改为 `streaming={generating || compacting}`。

4. 消息区顶部展示加载/失败态:在 `<div className={styles.messages}>` 内、`messages.length === 0` 判断之前插入:
```tsx
          {loading && <div className={styles.compactingBar}>正在加载对话…</div>}
          {loadError && <div className={styles.limitBar}>对话加载失败，请刷新重试。</div>}
```
(复用现有 `compactingBar`/`limitBar` 样式,避免新增 CSS。)

- [ ] **Step 2: 类型检查 + 构建**

Run: `cd packages/client && pnpm exec tsc --noEmit && pnpm run build`
Expected: tsc 无输出;build 成功。

- [ ] **Step 3: 前端全量测试**

Run: `cd packages/client && pnpm test`
Expected: PASS(lib 10 + useChat 3 = 13)。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/ChatView.tsx
git commit -m "feat(chat): ChatView 接入加载/失败态与生成中禁用"
```

---

### Task 10: 端到端手测 + 收尾

**Files:** 无(验证 + 文档)

- [ ] **Step 1: 服务端全量类型检查与测试**

Run:
```bash
cd packages/server && pnpm exec tsc --noEmit && pnpm exec tsx --test src/services/chatStore.test.ts src/services/chatGeneration.test.ts src/routes/chat.messages.test.ts src/routes/chat.stream.test.ts src/routes/chat.compact.test.ts
```
Expected: 全 PASS。

- [ ] **Step 2: 真实数据手测(管理员账号)**

按 `docmind-oauth-blocks-local-verify` 记忆,鉴权后界面需真实浏览器手测。启动 `pnpm run dev:server` + `pnpm run dev:client` + ChromaDB,登录后逐项验证:
1. 发一条消息 → 正常流式显示 → 刷新 → 完整对话仍在。
2. 发一条(触发天气工具、生成较慢)→ 生成中刷新 → 页面显示"广州天气如何" + 该 AI 气泡处于生成态 → 约 1-2s 后自动补齐完整答案。
3. 生成中输入框禁用;pin 切换刷新后仍在;清空后刷新为空。
4. 停服重启后,原"生成中"的消息显示为出错(不再卡死轮询)。

- [ ] **Step 3: 更新 CLAUDE.md 架构说明**

在 `CLAUDE.md` 的后端小节补一句 `services/chatStore.ts`(SQLite chat_messages,服务端对话持久化)与 `services/chatGeneration.ts`(断开续跑),并在"Key Design Decisions"里把"localStorage persistence"一条改为"服务端 DB 持久化 + 刷新轮询恢复"。提交。

```bash
git add CLAUDE.md && git commit -m "docs: 更新架构说明为服务端对话持久化"
```

- [ ] **Step 4: 开 PR**

```bash
git push -u origin feature/server-side-chat-persistence
gh pr create --title "feat(chat): 服务端对话持久化 + 刷新轮询恢复" --body "见 docs/superpowers/specs/2026-07-05-server-side-chat-persistence-design.md"
```

---

## Self-Review

**Spec 覆盖核对:**
- §3 数据模型 → Task 1/2(表 + 全部 chatStore 方法)。✅
- §4.1 stream 落库 + 断开续跑 + 409 + 历史从 DB → Task 5(断开续跑核心在 Task 3)。✅
- §4.2 GET/PATCH/DELETE → Task 4;compact → Task 6。✅
- §5 前端服务端为准 + 乐观追加 + 轮询 + 收尾控制 → Task 8;UI 态与生成中禁用 → Task 9。✅
- §6 错误与边界:断开续跑(T3)、LLM 错误(T3/T5)、崩溃兜底(T1)、并发 409(T5 + 前端 T8 回滚)、加载失败(T8)。✅
- §7 测试:服务端 node:test(T1-6)、前端 vitest(T7-9)、手测(T10)。✅
- §2 移除 localStorage → Task 8(useChat 重写不再含 localStorage)。✅
- 自动 pin 迁移到服务端 → Task 5(spec 未显式列,但为 server-as-truth 的必要连带,已纳入)。

**占位符扫描:** 无 TBD/TODO;每个代码步骤含完整代码。✅

**类型一致性:** `appendMessage`/`getMessages`/`updateMessageContent`/`hasGenerating`/`setPinned`/`clearMessages`/`replaceForCompaction` 在 Task 1/2 定义,Task 4/5/6 按同名同签名调用;`streamAndPersist({assistantId, stream, send})` 在 Task 3 定义、Task 5 调用一致;前端 `sendMessage(message, docIds?)` 在 Task 8 类型定义、Task 9 调用一致;`ChatMessage.status`/`id` 在 Task 8 加,前后端映射(`rowToChatMessage`,Task 4)字段对齐。✅
