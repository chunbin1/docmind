# 多会话（新建对话）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DocMind 从"单用户单对话"升级为 ChatGPT 式多会话——侧边栏列出历史会话，可新建、切换、删除，每条会话独立历史，且各会话可并发生成。

**Architecture:** 新增 `conversations` 表并给 `chat_messages` 加 `conversation_id` 外键列；所有 chat 存取按会话维度；`generationRegistry` 改为按 `conversationId` 键，实现服务端并发生成。前端拆出 `useConversations` hook 管列表/选中，`useChat` 接收 `conversationId` 并支持惰性创建；客户端同一时刻只实时流式当前会话，后台会话靠既有轮询恢复。

**Tech Stack:** Fastify + better-sqlite3（ESM NodeNext，`.js` 后缀导入）、node:test（服务端）、React 19 + Vite、vitest + @testing-library/react（客户端）、CSS Modules。

## Global Constraints

- 服务端 ESM NodeNext：所有相对导入带 `.js` 后缀；模块用 `import`/`export`。
- 服务端测试用 `node:test` + `node:assert/strict`，内存库 `new Database(':memory:')` + `initChatTables(db)`。
- 客户端测试用 `vitest` + `@testing-library/react`，`vi.stubGlobal('fetch', ...)`。
- 客户端样式一律 CSS Modules（`App.module.css`），UI 文案中文。
- 配额：每用户消息上限**全局总量不变**，跨会话共享（`incrementMessageCount`/`canSend` 逻辑不动）。
- 记忆与文档保持**用户全局共享**，不加 conversation 维度。
- 并发模型：每会话至多一个活跃生成；`hasGenerating`/`generationRegistry` 一律按 `conversationId`。
- 所有权：任何带 `conversationId` 的请求先校验 `conversation.user_id === user.id`，否则 404。
- 默认会话标题常量 `DEFAULT_CONVERSATION_TITLE = '新对话'`。
- localStorage 键风格沿用 `docmind:xxx:${userId}`（当前选中会话用 `docmind:currentConv:${userId}`）。

## File Structure

**后端**
- `packages/server/src/services/chatStore.ts` — 新 `conversations` 表 + 迁移/backfill；`chat_messages` 加 `conversation_id`；消息存取与 `seq`/`hasGenerating` 改按会话；会话 CRUD 函数；标题工具。
- `packages/server/src/services/generationRegistry.ts` — 键从 userId 改为 conversationId（语义调整）。
- `packages/server/src/routes/chat.ts` — 会话 CRUD 路由；`/chat/stream`、`/chat/messages`、`/chat/stop`、`/chat/compact` 加 `conversationId`；标题自动生成；移除 `DELETE /chat/messages`。

**前端**
- `packages/client/src/types.ts` — `Conversation`、`UseConversationsReturn` 类型；`UseChatReturn` 去掉 `clearMessages`。
- `packages/client/src/hooks/useConversations.ts` — 新增：会话列表 + 选中 + 新建/删除/刷新 + 生成中轮询。
- `packages/client/src/hooks/useChat.ts` — 按 `conversationId` 重构 + 惰性创建 + stop 带 conversationId。
- `packages/client/src/components/ConversationList.tsx` — 新增：侧边栏会话列表 UI。
- `packages/client/src/components/ChatView.tsx` — 接入两个 hook 与新组件；移除底部"清空对话"。
- `packages/client/src/App.module.css` — 会话列表样式。

**文档**
- `CLAUDE.md` — 更新架构、API 表、设计决策。

---

## Task 1: chatStore 多会话数据层

**Files:**
- Modify: `packages/server/src/services/chatStore.ts`（整体重写，见下）
- Test: `packages/server/src/services/chatStore.test.ts`（整体重写）

**Interfaces:**
- Produces:
  - `interface Conversation { id: string; user_id: string; title: string; created_at: string; updated_at: string }`
  - `interface ConversationSummary { id: string; title: string; updated_at: string; message_count: number; generating: boolean }`
  - `const DEFAULT_CONVERSATION_TITLE = '新对话'`
  - `titleFromMessage(message: string): string`
  - `createConversation(userId: string): { id: string }`
  - `getConversation(id: string): Conversation | undefined`
  - `listConversations(userId: string): ConversationSummary[]`
  - `deleteConversation(userId: string, id: string): boolean`
  - `setConversationTitle(id: string, title: string): void`
  - `appendMessage(userId: string, conversationId: string, m: AppendInput): { id: string; seq: number }`
  - `getMessages(conversationId: string): ChatMessageRow[]`
  - `hasGenerating(conversationId: string): boolean`
  - `replaceForCompaction(userId: string, conversationId: string, deleteIds: string[], summary: string): void`
  - 不变：`initChatTables`、`updateMessageContent`、`markErrorIfGenerating`、`setPinned`
  - **移除**：`clearMessages`
  - `ChatMessageRow` 新增字段 `conversation_id: string | null`

- [ ] **Step 1: 重写测试（先失败）**

把 `packages/server/src/services/chatStore.test.ts` 整体替换为：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  initChatTables, createConversation, getConversation, listConversations,
  deleteConversation, setConversationTitle, titleFromMessage,
  appendMessage, getMessages, updateMessageContent, hasGenerating,
  setPinned, replaceForCompaction, markErrorIfGenerating,
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

test('setPinned / updateMessageContent / markErrorIfGenerating 仍工作', () => {
  const db = setup()
  const c1 = createConversation('u1').id
  const { id } = appendMessage('u1', c1, { role: 'assistant', content: '', status: 'generating' })
  updateMessageContent(id, '完整答案', 'done')
  assert.equal(getMessages(c1)[0].content, '完整答案')
  setPinned('u1', id, true)
  assert.equal(getMessages(c1)[0].pinned, 1)
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatStore.test.ts`
Expected: FAIL（`createConversation` 等未导出 / 签名不符）

- [ ] **Step 3: 重写 chatStore.ts**

把 `packages/server/src/services/chatStore.ts` 整体替换为：

```ts
// packages/server/src/services/chatStore.ts
import type { DB } from './memoryStore.js'

export type ChatRole = 'user' | 'assistant' | 'summary'
export type ChatStatus = 'generating' | 'done' | 'error'

export const DEFAULT_CONVERSATION_TITLE = '新对话'

export interface ChatMessageRow {
  id: string
  user_id: string
  conversation_id: string | null
  seq: number
  role: ChatRole
  content: string
  status: ChatStatus
  pinned: number | null
  compacted_count: number | null
  compacted_at: number | null
  created_at: string
  reasoning: string | null
}

export interface AppendInput {
  role: ChatRole
  content: string
  status?: ChatStatus
  pinned?: boolean
  compactedCount?: number
  compactedAt?: number
}

export interface Conversation {
  id: string
  user_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ConversationSummary {
  id: string
  title: string
  updated_at: string
  message_count: number
  generating: boolean
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
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '${DEFAULT_CONVERSATION_TITLE}',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at);
  `)
  // idempotent 迁移：补 reasoning 列（推理内容）与 conversation_id 列（多会话）。
  try { db.exec('ALTER TABLE chat_messages ADD COLUMN reasoning TEXT') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE chat_messages ADD COLUMN conversation_id TEXT') } catch { /* 列已存在 */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_conv_seq ON chat_messages(conversation_id, seq)')

  backfillConversations(db)

  // Crash recovery: 进程重启后没有真正在飞的生成，把遗留 generating 翻成 error。
  db.prepare("UPDATE chat_messages SET status='error' WHERE status='generating'").run()
}

// 把历史"单会话"消息（conversation_id IS NULL）归入每用户一条会话。幂等：只作用于 NULL 行。
function backfillConversations(db: DB): void {
  const legacyUsers = db.prepare(
    'SELECT DISTINCT user_id FROM chat_messages WHERE conversation_id IS NULL',
  ).all() as { user_id: string }[]

  for (const { user_id } of legacyUsers) {
    const bounds = db.prepare(`
      SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM chat_messages WHERE user_id = ? AND conversation_id IS NULL
    `).get(user_id) as { first_at: string | null; last_at: string | null }
    const firstUser = db.prepare(`
      SELECT content FROM chat_messages
      WHERE user_id = ? AND conversation_id IS NULL AND role = 'user'
      ORDER BY seq ASC LIMIT 1
    `).get(user_id) as { content: string } | undefined

    const convId = genConvId()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO conversations (id, user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      convId, user_id,
      firstUser ? titleFromMessage(firstUser.content) : DEFAULT_CONVERSATION_TITLE,
      bounds.first_at ?? now, bounds.last_at ?? now,
    )
    db.prepare(
      'UPDATE chat_messages SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL',
    ).run(convId, user_id)
  }
}

export function titleFromMessage(message: string): string {
  const firstLine = (message || '').trim().split('\n')[0].trim()
  if (!firstLine) return DEFAULT_CONVERSATION_TITLE
  return firstLine.length <= 24 ? firstLine : firstLine.slice(0, 24) + '…'
}

function db(): DB {
  if (!_db) throw new Error('chatStore not initialized — call initChatTables() first')
  return _db
}

function genId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}
function genConvId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

// === 会话 CRUD ===

export function createConversation(userId: string): { id: string } {
  const id = genConvId()
  const now = new Date().toISOString()
  db().prepare(`
    INSERT INTO conversations (id, user_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, DEFAULT_CONVERSATION_TITLE, now, now)
  return { id }
}

export function getConversation(id: string): Conversation | undefined {
  return db().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined
}

export function listConversations(userId: string): ConversationSummary[] {
  const rows = db().prepare(`
    SELECT
      c.id, c.title, c.updated_at,
      SUM(CASE WHEN m.id IS NOT NULL AND m.role != 'summary' THEN 1 ELSE 0 END) AS message_count,
      MAX(CASE WHEN m.status = 'generating' THEN 1 ELSE 0 END) AS generating
    FROM conversations c
    LEFT JOIN chat_messages m ON m.conversation_id = c.id
    WHERE c.user_id = ?
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all(userId) as Array<{
    id: string; title: string; updated_at: string
    message_count: number | null; generating: number | null
  }>
  return rows.map(r => ({
    id: r.id, title: r.title, updated_at: r.updated_at,
    message_count: Number(r.message_count) || 0,
    generating: !!r.generating,
  }))
}

export function deleteConversation(userId: string, id: string): boolean {
  const conv = getConversation(id)
  if (!conv || conv.user_id !== userId) return false
  const tx = db().transaction(() => {
    db().prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id)
    db().prepare('DELETE FROM conversations WHERE id = ?').run(id)
  })
  tx()
  return true
}

export function setConversationTitle(id: string, title: string): void {
  db().prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
}

function touchConversation(id: string): void {
  db().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

// === 消息（按会话）===

export function appendMessage(userId: string, conversationId: string, m: AppendInput): { id: string; seq: number } {
  const id = genId()
  const { next } = db()
    .prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM chat_messages WHERE conversation_id = ?')
    .get(conversationId) as { next: number }
  db().prepare(`
    INSERT INTO chat_messages
      (id, user_id, conversation_id, seq, role, content, status, pinned, compacted_count, compacted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, conversationId, next, m.role, m.content, m.status ?? 'done',
    m.pinned ? 1 : null, m.compactedCount ?? null, m.compactedAt ?? null,
    new Date().toISOString(),
  )
  touchConversation(conversationId)
  return { id, seq: next }
}

export function getMessages(conversationId: string): ChatMessageRow[] {
  return db()
    .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq ASC')
    .all(conversationId) as ChatMessageRow[]
}

export function updateMessageContent(id: string, content: string, status: ChatStatus, reasoning?: string): void {
  if (reasoning === undefined) {
    db().prepare('UPDATE chat_messages SET content = ?, status = ? WHERE id = ?').run(content, status, id)
  } else {
    db().prepare('UPDATE chat_messages SET content = ?, status = ?, reasoning = ? WHERE id = ?')
      .run(content, status, reasoning || null, id)
  }
}

export function markErrorIfGenerating(id: string, fallbackContent: string): void {
  db().prepare(
    "UPDATE chat_messages SET status='error', content = CASE WHEN content='' THEN ? ELSE content END WHERE id = ? AND status='generating'",
  ).run(fallbackContent, id)
}

export function hasGenerating(conversationId: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM chat_messages WHERE conversation_id = ? AND status = 'generating' LIMIT 1")
    .get(conversationId)
  return !!row
}

export function setPinned(userId: string, id: string, pinned: boolean): void {
  db().prepare('UPDATE chat_messages SET pinned = ? WHERE id = ? AND user_id = ?')
    .run(pinned ? 1 : null, id, userId)
}

export function replaceForCompaction(userId: string, conversationId: string, deleteIds: string[], summary: string): void {
  const tx = db().transaction(() => {
    const del = db().prepare('DELETE FROM chat_messages WHERE id = ? AND conversation_id = ?')
    for (const id of deleteIds) del.run(id, conversationId)
    // Summary 成为该会话最早的一条：当前最小 seq 再减 1。
    const { prev } = db()
      .prepare('SELECT COALESCE(MIN(seq),1)-1 AS prev FROM chat_messages WHERE conversation_id = ?')
      .get(conversationId) as { prev: number }
    db().prepare(`
      INSERT INTO chat_messages
        (id, user_id, conversation_id, seq, role, content, status, pinned, compacted_count, compacted_at, created_at)
      VALUES (?, ?, ?, ?, 'summary', ?, 'done', NULL, ?, ?, ?)
    `).run(genId(), userId, conversationId, prev, summary, deleteIds.length, Date.now(), new Date().toISOString())
    touchConversation(conversationId)
  })
  tx()
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/server && pnpm exec tsx --test src/services/chatStore.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/chatStore.ts packages/server/src/services/chatStore.test.ts
git commit -m "feat(chat): chatStore 支持多会话（conversations 表 + 迁移 + 按会话存取）"
```

---

## Task 2: generationRegistry 按会话键

**Files:**
- Modify: `packages/server/src/services/generationRegistry.ts`
- Test: `packages/server/src/services/generationRegistry.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces（签名形状不变，语义键改为 conversationId）：
  - `registerGeneration(conversationId: string): AbortController`
  - `unregisterGeneration(conversationId: string, ac: AbortController): void`
  - `abortGeneration(conversationId: string): boolean`

- [ ] **Step 1: 写失败测试**

新建 `packages/server/src/services/generationRegistry.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerGeneration, unregisterGeneration, abortGeneration,
} from './generationRegistry.js'

test('不同会话的生成互不影响，可各自 abort', () => {
  const a = registerGeneration('conv-a')
  const b = registerGeneration('conv-b')
  assert.equal(a.signal.aborted, false)
  assert.equal(b.signal.aborted, false)

  assert.equal(abortGeneration('conv-a'), true)
  assert.equal(a.signal.aborted, true)
  assert.equal(b.signal.aborted, false) // 另一会话不受影响

  assert.equal(abortGeneration('conv-a'), false) // 已移除
  unregisterGeneration('conv-b', b)
  assert.equal(abortGeneration('conv-b'), false)
})

test('同一会话重复 register 会 abort 旧的', () => {
  const first = registerGeneration('conv-x')
  const second = registerGeneration('conv-x')
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  abortGeneration('conv-x')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/services/generationRegistry.test.ts`
Expected: PASS 或 FAIL——当前实现按 userId 键，形状相同故测试可能已通过。若通过，仍继续 Step 3 更新注释与参数名以反映会话语义。

- [ ] **Step 3: 更新实现**

把 `packages/server/src/services/generationRegistry.ts` 整体替换为：

```ts
// Tracks in-flight chat generations so an explicit "stop" request can cancel
// them. Keyed by conversationId — each conversation may have at most one active
// generation, and different conversations of the same user run concurrently.
// This is deliberately an *explicit* cancel channel — a mere client disconnect
// does NOT abort here, so the "keep generating after refresh" behavior stays intact.

const controllers = new Map<string, AbortController>()

/** Register a new in-flight generation for a conversation; returns its AbortController. */
export function registerGeneration(conversationId: string): AbortController {
  // Defensive: if a stale controller lingers, abort it before replacing.
  controllers.get(conversationId)?.abort()
  const ac = new AbortController()
  controllers.set(conversationId, ac)
  return ac
}

/** Remove a generation once it finishes — only if it's still the current one. */
export function unregisterGeneration(conversationId: string, ac: AbortController): void {
  if (controllers.get(conversationId) === ac) controllers.delete(conversationId)
}

/** Abort the conversation's in-flight generation. Returns true if one was running. */
export function abortGeneration(conversationId: string): boolean {
  const ac = controllers.get(conversationId)
  if (!ac) return false
  ac.abort()
  controllers.delete(conversationId)
  return true
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/server && pnpm exec tsx --test src/services/generationRegistry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/generationRegistry.ts packages/server/src/services/generationRegistry.test.ts
git commit -m "feat(chat): generationRegistry 改按 conversationId 键，支持会话级并发"
```

---

## Task 3: chat 路由接入多会话

**Files:**
- Modify: `packages/server/src/routes/chat.ts`
- Test: `packages/server/src/routes/chat.messages.test.ts`、`chat.stream.test.ts`、`chat.compact.test.ts`（更新签名 + 新增会话路由测试）

**Interfaces:**
- Consumes: Task 1 的 chatStore 全部导出、Task 2 的 registry 导出。
- Produces（HTTP）：
  - `GET /api/chat/conversations` → `{ conversations: ConversationSummary[] }`
  - `POST /api/chat/conversations` → `{ id: string }`
  - `DELETE /api/chat/conversations/:id` → `{ ok: true }`（未拥有 → 404）
  - `GET /api/chat/messages?conversationId=xxx` → `{ messages }`（缺参 → 400，未拥有 → 404）
  - `POST /api/chat/stream` body `{ conversationId, message, docIds? }`
  - `POST /api/chat/stop` body `{ conversationId }`
  - `POST /api/chat/compact` body `{ conversationId, ids }`
  - **移除** `DELETE /api/chat/messages`

- [ ] **Step 1: 更新现有路由测试（先失败）**

替换 `packages/server/src/routes/chat.messages.test.ts` 为：

```ts
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

test('PATCH /api/chat/messages/:id 改 pinned', async () => {
  const { app, db } = await buildApp()
  const c = createConversation('dev').id
  const { id } = appendMessage('dev', c, { role: 'user', content: '记住' })
  const res = await app.inject({
    method: 'PATCH', url: `/api/chat/messages/${id}`, payload: { pinned: true },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(getMessages(c)[0].pinned, 1)
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
```

替换 `packages/server/src/routes/chat.stream.test.ts` 为：

```ts
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
```

替换 `packages/server/src/routes/chat.compact.test.ts` 为：

```ts
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

test('POST /chat/compact 用空 ids 时不改动对话（边界短路）', async () => {
  const { app, db } = await buildApp()
  const c = createConversation('dev').id
  appendMessage('dev', c, { role: 'user', content: '只此一条' })
  const res = await app.inject({
    method: 'POST', url: '/api/chat/compact', payload: { conversationId: c, ids: [] },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(getMessages(c).length, 1)
  await app.close(); db.close()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.messages.test.ts src/routes/chat.stream.test.ts src/routes/chat.compact.test.ts`
Expected: FAIL（路由未实现会话逻辑 / 签名不符）

- [ ] **Step 3a: 更新 chat.ts 的 import**

在 `packages/server/src/routes/chat.ts` 顶部，把 chatStore 的 import 块替换为：

```ts
import {
  getMessages, setPinned, appendMessage, hasGenerating, replaceForCompaction,
  markErrorIfGenerating, createConversation, getConversation, listConversations,
  deleteConversation, setConversationTitle, titleFromMessage, DEFAULT_CONVERSATION_TITLE,
  type ChatMessageRow, type ChatRole, type ChatStatus,
} from '../services/chatStore.js'
```

- [ ] **Step 3b: 更新 StreamBody / CompactBody 类型**

把这两个接口替换为：

```ts
interface StreamBody {
  conversationId: string
  message: string
  docIds?: string[]
}

interface CompactBody {
  conversationId: string
  ids: string[]
}
```

- [ ] **Step 3c: 新增会话 CRUD 路由 + 改 messages 路由，移除 DELETE /chat/messages**

在 `chatRoutes` 内，把原 `GET /chat/messages`、`DELETE /chat/messages` 两段替换为：

```ts
  app.get('/chat/conversations', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    return { conversations: listConversations(user.id) }
  })

  app.post('/chat/conversations', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    return createConversation(user.id)
  })

  app.delete<{ Params: { id: string } }>('/chat/conversations/:id', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    // 删除前先中断该会话可能在飞的生成，避免续写落到已删会话。
    abortGeneration(request.params.id)
    const ok = deleteConversation(user.id, request.params.id)
    if (!ok) return reply.status(404).send({ error: 'not_found' })
    return { ok: true }
  })

  app.get<{ Querystring: { conversationId?: string } }>('/chat/messages', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const { conversationId } = request.query
    if (!conversationId) return reply.status(400).send({ error: 'conversationId is required' })
    const conv = getConversation(conversationId)
    if (!conv || conv.user_id !== user.id) return reply.status(404).send({ error: 'not_found' })
    return { messages: getMessages(conversationId).map(rowToChatMessage) }
  })
```

（`PATCH /chat/messages/:id` 保持不变。）

- [ ] **Step 3d: 改 stop 路由带 conversationId**

把 `POST /chat/stop` 段替换为：

```ts
  app.post<{ Body: { conversationId?: string } }>('/chat/stop', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const conversationId = request.body?.conversationId
    if (!conversationId) return reply.status(400).send({ error: 'conversationId is required' })
    const conv = getConversation(conversationId)
    if (!conv || conv.user_id !== user.id) return reply.status(404).send({ error: 'not_found' })
    const stopped = abortGeneration(conversationId)
    return { ok: true, stopped }
  })
```

- [ ] **Step 3e: 改 stream 路由（会话校验 + 按会话落库/取历史/锁 + 标题自动生成 + 按会话注册生成）**

在 `POST /chat/stream` handler 内做以下替换：

1. 校验 message 之后、`hasGenerating` 之前，加入会话解析与校验。把从 `const { message, docIds = [] } = request.body` 到 `incrementMessageCount(user.id)` 之间替换为：

```ts
    const { conversationId, message, docIds = [] } = request.body
    if (!conversationId) return reply.status(400).send({ error: 'conversationId is required' })
    if (!message?.trim()) return reply.status(400).send({ error: 'message is required' })

    const conv = getConversation(conversationId)
    if (!conv || conv.user_id !== user.id) return reply.status(404).send({ error: 'not_found' })

    // 会话级并发锁：仅当"这条会话"还在生成时拒绝，别的会话不受影响。
    if (hasGenerating(conversationId)) {
      return reply.status(409).send({ error: 'generating_in_progress' })
    }

    incrementMessageCount(user.id)

    // 历史以 DB 为准（按会话）。
    const prior = getMessages(conversationId)
    const summaryRow = prior.find(m => m.role === 'summary')
    const history: LLMMessage[] = prior
      .filter(m => m.role !== 'summary')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, pinned: !!m.pinned }))

    // 首条用户消息 → 自动生成会话标题（仅当仍是默认标题）。
    if (conv.title === DEFAULT_CONVERSATION_TITLE) {
      setConversationTitle(conversationId, titleFromMessage(message))
    }

    // 落库本轮 user + assistant 占位（按会话）。
    appendMessage(user.id, conversationId, { role: 'user', content: message, pinned: isAutoPinned(message) })
    const asst = appendMessage(user.id, conversationId, { role: 'assistant', content: '', status: 'generating' })
```

2. 删除原先紧随其后的旧代码块（旧的 `const { message, docIds = [] } = request.body` 校验、旧 `hasGenerating(user.id)`、旧 `incrementMessageCount`、旧 `getMessages(user.id)`、旧两处 `appendMessage(user.id, {...})`）——它们已被上面整体取代，确保不残留。

3. 把注册生成一行 `const ac = registerGeneration(user.id)` 改为：

```ts
        const ac = registerGeneration(conversationId)
```

4. 把 `unregisterGeneration(user.id, ac)` 改为：

```ts
            unregisterGeneration(conversationId, ac)
```

- [ ] **Step 3f: 改 compact 路由按会话**

把 `POST /chat/compact` handler 内做以下替换：

1. body 解构与校验：

```ts
    const { conversationId, ids } = request.body
    if (!conversationId) return reply.status(400).send({ error: 'conversationId is required' })
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: 'ids is required' })
    }
    const conv = getConversation(conversationId)
    if (!conv || conv.user_id !== user.id) return reply.status(404).send({ error: 'not_found' })

    const byId = new Map(getMessages(conversationId).map(m => [m.id, m]))
```

2. 把 `replaceForCompaction(user.id, targets.map(m => m.id), summary)` 改为：

```ts
      replaceForCompaction(user.id, conversationId, targets.map(m => m.id), summary)
```

（`runInTrace` 的 route 名等其它逻辑不变。）

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/server && pnpm exec tsx --test src/routes/chat.messages.test.ts src/routes/chat.stream.test.ts src/routes/chat.compact.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 服务端整体类型检查**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: 无错误（若报 `clearMessages` 找不到，检查是否有残留引用并删除）

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/routes/chat.ts packages/server/src/routes/chat.messages.test.ts packages/server/src/routes/chat.stream.test.ts packages/server/src/routes/chat.compact.test.ts
git commit -m "feat(chat): 路由接入多会话（会话 CRUD + conversationId 贯穿 stream/messages/stop/compact）"
```

---

## Task 4: 前端类型 + useConversations hook

**Files:**
- Modify: `packages/client/src/types.ts`
- Create: `packages/client/src/hooks/useConversations.ts`
- Test: `packages/client/src/hooks/useConversations.test.ts`（新建）

**Interfaces:**
- Consumes: HTTP `GET/POST/DELETE /api/chat/conversations`
- Produces:
  - `interface Conversation { id: string; title: string; updated_at: string; message_count: number; generating: boolean }`
  - `interface UseConversationsReturn { conversations: Conversation[]; currentId: string | null; loading: boolean; selectConversation: (id: string) => void; newConversation: () => void; deleteConversation: (id: string) => void; onConversationCreated: (id: string) => void; refresh: () => void }`
  - `useConversations(userId: string | null): UseConversationsReturn`

- [ ] **Step 1: 加类型**

在 `packages/client/src/types.ts` 末尾追加：

```ts
// === 多会话类型 ===

/** 会话列表项（对齐 server ConversationSummary） */
export interface Conversation {
  id: string
  title: string
  updated_at: string
  message_count: number
  generating: boolean
}

/** useConversations 暴露给组件的接口 */
export interface UseConversationsReturn {
  conversations: Conversation[]
  currentId: string | null
  loading: boolean
  selectConversation: (id: string) => void
  newConversation: () => void
  deleteConversation: (id: string) => void
  /** useChat 惰性建会话后回调：把新会话设为当前并乐观插入列表 */
  onConversationCreated: (id: string) => void
  refresh: () => void
}
```

并把 `UseChatReturn` 里的 `clearMessages: () => void` 一行删除（Task 5 会同步改 useChat）。

- [ ] **Step 2: 写失败测试**

新建 `packages/client/src/hooks/useConversations.test.ts`：

```ts
import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useConversations } from './useConversations'
import type { Conversation } from '../types'

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

const list: Conversation[] = [
  { id: 'c1', title: '会话一', updated_at: '2026-07-05T10:00:00Z', message_count: 2, generating: false },
  { id: 'c2', title: '会话二', updated_at: '2026-07-05T09:00:00Z', message_count: 0, generating: false },
]

test('加载：拉列表并默认选中第一条（最近）', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.conversations.map(c => c.id)).toEqual(['c1', 'c2'])
  expect(result.current.currentId).toBe('c1')
})

test('恢复 localStorage 选中；失效则回落最近', async () => {
  localStorage.setItem('docmind:currentConv:u1', 'c2')
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.currentId).toBe('c2'))
})

test('newConversation 置 currentId=null（草稿）', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.currentId).toBe('c1'))
  act(() => { result.current.newConversation() })
  expect(result.current.currentId).toBe(null)
})

test('onConversationCreated 乐观插入并设为当前', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => { result.current.onConversationCreated('c-new') })
  expect(result.current.currentId).toBe('c-new')
  expect(result.current.conversations[0].id).toBe('c-new')
})

test('deleteConversation 删当前时选下一条', async () => {
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
    if (opts?.method === 'DELETE') return jsonRes({ ok: true })
    return jsonRes({ conversations: list })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.currentId).toBe('c1'))
  act(() => { result.current.deleteConversation('c1') })
  expect(result.current.conversations.some(c => c.id === 'c1')).toBe(false)
  expect(result.current.currentId).toBe('c2')
})
```

- [ ] **Step 3: 运行确认失败**

Run: `cd packages/client && pnpm exec vitest run src/hooks/useConversations.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 useConversations**

新建 `packages/client/src/hooks/useConversations.ts`：

```ts
import { useState, useEffect, useRef, useCallback } from 'react'
import type { Conversation, UseConversationsReturn } from '../types'

const storageKey = (userId: string): string => `docmind:currentConv:${userId}`
const POLL_MS = 2000

export function useConversations(userId: string | null): UseConversationsReturn {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 供 deleteConversation 基于最新值计算，不受闭包过期影响。
  const conversationsRef = useRef<Conversation[]>([])
  const currentIdRef = useRef<string | null>(null)

  useEffect(() => { conversationsRef.current = conversations }, [conversations])
  useEffect(() => { currentIdRef.current = currentId }, [currentId])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchList = useCallback(async (): Promise<Conversation[]> => {
    const res = await fetch('/api/chat/conversations')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { conversations: Conversation[] }
    return body.conversations
  }, [])

  const refresh = useCallback((): void => {
    fetchList()
      .then(l => { if (mountedRef.current) setConversations(l) })
      .catch(() => {})
  }, [fetchList])

  const setCurrent = useCallback((id: string | null): void => {
    setCurrentId(id)
    currentIdRef.current = id
    if (userId) {
      try {
        if (id) localStorage.setItem(storageKey(userId), id)
        else localStorage.removeItem(storageKey(userId))
      } catch { /* 存储不可用则忽略 */ }
    }
  }, [userId])

  // 加载会话列表（userId 变化 / 登出清空）。
  useEffect(() => {
    if (!userId) { setConversations([]); setCurrentId(null); return }
    setLoading(true)
    fetchList()
      .then(l => {
        if (!mountedRef.current) return
        setConversations(l)
        let saved: string | null = null
        try { saved = localStorage.getItem(storageKey(userId)) } catch { /* ignore */ }
        const validSaved = saved && l.some(c => c.id === saved) ? saved : null
        setCurrentId(validSaved ?? l[0]?.id ?? null)
      })
      .catch(() => { if (mountedRef.current) { setConversations([]); setCurrentId(null) } })
      .finally(() => { if (mountedRef.current) setLoading(false) })
  }, [userId, fetchList])

  // 存在 generating 会话时 2s 轮询刷新列表（更新"生成中"圆点）；无则停轮询。
  useEffect(() => {
    const anyGenerating = conversations.some(c => c.generating)
    if (!anyGenerating) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(refresh, POLL_MS)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [conversations, refresh])

  const selectConversation = useCallback((id: string): void => { setCurrent(id) }, [setCurrent])
  const newConversation = useCallback((): void => { setCurrent(null) }, [setCurrent])

  const onConversationCreated = useCallback((id: string): void => {
    setConversations(prev =>
      prev.some(c => c.id === id)
        ? prev
        : [{ id, title: '新对话', updated_at: new Date().toISOString(), message_count: 0, generating: true }, ...prev],
    )
    setCurrent(id)
  }, [setCurrent])

  const deleteConversation = useCallback((id: string): void => {
    const remaining = conversationsRef.current.filter(c => c.id !== id)
    setConversations(remaining)
    if (currentIdRef.current === id) setCurrent(remaining[0]?.id ?? null)
    fetch(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(() => refresh())
      .catch(() => {})
  }, [setCurrent, refresh])

  return {
    conversations, currentId, loading,
    selectConversation, newConversation, deleteConversation, onConversationCreated, refresh,
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/client && pnpm exec vitest run src/hooks/useConversations.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/client/src/types.ts packages/client/src/hooks/useConversations.ts packages/client/src/hooks/useConversations.test.ts
git commit -m "feat(client): 新增 useConversations hook（会话列表/选中/新建/删除/生成中轮询）"
```

---

## Task 5: useChat 按 conversationId 重构

**Files:**
- Modify: `packages/client/src/hooks/useChat.ts`
- Test: `packages/client/src/hooks/useChat.test.ts`（更新调用签名 + 新增惰性创建用例）

**Interfaces:**
- Consumes: Task 4 的 `onConversationCreated`；HTTP `POST /api/chat/conversations`、`/chat/stream`、`/chat/stop`、`/chat/compact`、`GET /chat/messages?conversationId=`
- Produces:
  - `useChat(userId: string | null, conversationId: string | null, onConversationCreated: (id: string) => void): UseChatReturn`
  - `UseChatReturn` 不再含 `clearMessages`

- [ ] **Step 1: 更新测试（先失败）**

替换 `packages/client/src/hooks/useChat.test.ts` 中所有 `useChat('u1')` 调用为 `useChat('u1', 'c1', () => {})`，并把并发防护用例的 `renderHook(({ userId }) => useChat(userId), ...)` 改为传三参。具体：

1. 顶部加一个 noop 常量（放在 `jsonRes` 之后）：

```ts
const noop = () => {}
```

2. 逐个替换：
   - `renderHook(() => useChat('u1'))` → `renderHook(() => useChat('u1', 'c1', noop))`（出现多处，全部替换）
   - `renderHook(() => useChat('u1'), { wrapper: StrictMode })` → `renderHook(() => useChat('u1', 'c1', noop), { wrapper: StrictMode })`
   - 并发防护用例：
     ```ts
     const { result, rerender } = renderHook(
       ({ userId }) => useChat(userId, 'c1', noop),
       { initialProps: { userId: 'u1' as string | null } },
     )
     ```

3. 追加一个惰性创建用例：

```ts
test('惰性创建：conversationId 为 null 时首发先 POST /conversations 再流式', async () => {
  const created: string[] = []
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    calls.push(url)
    if (url === '/api/chat/conversations' && opts?.method === 'POST') {
      return jsonRes({ id: 'c-new' })
    }
    if (url === '/api/chat/stream') {
      // 断言 stream body 带上了新会话 id
      const body = JSON.parse(opts?.body ?? '{}') as { conversationId?: string }
      created.push(body.conversationId ?? '')
      // 返回一个立即 done 的 SSE 流
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"text":"你好"}\n\n'))
          controller.enqueue(new TextEncoder().encode('data: {"done":true}\n\n'))
          controller.close()
        },
      })
      return { ok: true, status: 200, body: stream } as unknown as Response
    }
    return jsonRes({ messages: [] })
  }) as unknown as typeof fetch)

  const onCreated = vi.fn()
  const { result } = renderHook(() => useChat('u1', null, onCreated))
  await act(async () => { await result.current.sendMessage('你好') })
  expect(calls).toContain('/api/chat/conversations')
  expect(created).toEqual(['c-new'])
  expect(onCreated).toHaveBeenCalledWith('c-new')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/client && pnpm exec vitest run src/hooks/useChat.test.ts`
Expected: FAIL（`useChat` 参数不符 / 惰性创建未实现）

- [ ] **Step 3: 重写 useChat.ts**

把 `packages/client/src/hooks/useChat.ts` 整体替换为：

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

export function useChat(
  userId: string | null,
  conversationId: string | null,
  onConversationCreated: (id: string) => void,
): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const turnCountRef = useRef(0)
  const messagesRef = useRef<ChatMessage[]>(messages)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // 换会话防护：conversationId 每次变化 effect 递增，飞行中的首拉/轮询核对后作废。
  const runIdRef = useRef(0)
  // 当前会话 id 的镜像，供 fetchMessages/stop 读取最新值（避免闭包过期）。
  const convIdRef = useRef<string | null>(conversationId)
  // 刚由本地惰性创建的会话：加载 effect 跳过拉取，保留乐观占位。
  const skipLoadForRef = useRef<string | null>(null)

  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { convIdRef.current = conversationId }, [conversationId])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
  }, [])

  const fetchMessages = useCallback(async (): Promise<ChatMessage[]> => {
    const cid = convIdRef.current
    if (!cid) return []
    const res = await fetch(`/api/chat/messages?conversationId=${encodeURIComponent(cid)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { messages: ChatMessage[] }
    return body.messages
  }, [])

  const startPolling = useCallback((deadline: number, myRun: number) => {
    stopPolling()
    pollTimerRef.current = setTimeout(async () => {
      const isStale = () => !mountedRef.current || runIdRef.current !== myRun
      try {
        const msgs = await fetchMessages()
        if (isStale()) return
        setMessages(msgs)
        if (lastIsGenerating(msgs) && Date.now() < deadline) {
          startPolling(deadline, myRun)
        } else if (lastIsGenerating(msgs)) {
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
        if (isStale()) return
        if (Date.now() < deadline) startPolling(deadline, myRun)
      }
    }, POLL_INTERVAL_MS)
  }, [fetchMessages, stopPolling])

  // 加载当前会话消息（userId/会话变化触发；草稿 conversationId=null 时清空）。
  useEffect(() => {
    stopPolling()
    runIdRef.current += 1
    const myRun = runIdRef.current
    const isStale = () => !mountedRef.current || runIdRef.current !== myRun
    if (!userId || !conversationId) { setMessages([]); setLoadError(false); setLoading(false); return }
    // 本地刚创建的会话：跳过拉取，保留 sendMessage 里已放的乐观占位。
    if (skipLoadForRef.current === conversationId) {
      skipLoadForRef.current = null
      setLoading(false)
      return
    }
    setLoading(true); setLoadError(false)
    fetchMessages()
      .then(msgs => {
        if (isStale()) return
        setMessages(msgs)
        if (lastIsGenerating(msgs)) startPolling(Date.now() + POLL_MAX_MS, myRun)
      })
      .catch(() => { if (!isStale()) { setMessages([]); setLoadError(true) } })
      .finally(() => { if (!isStale()) setLoading(false) })
    return () => { stopPolling() }
  }, [userId, conversationId, fetchMessages, startPolling, stopPolling])

  const appendToLast = (text: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, content: last.content + text }
      return updated
    })
  }

  const appendReasoningToLast = (text: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + text }
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

  const compactIfNeeded = useCallback(async (convId: string): Promise<void> => {
    const current = messagesRef.current
    const chat = current.filter(m => m.role !== 'summary')
    if (totalTokens(chat) < COMPACT_THRESHOLD) return
    const old = chat.slice(0, -COMPACT_KEEP_RECENT)
    if (old.length === 0) return

    const existingSummaryIds = current
      .filter(m => m.role === 'summary' && m.id)
      .map(m => m.id as string)
    const oldIds = old.map(m => m.id).filter((x): x is string => !!x)
    const ids = [...existingSummaryIds, ...oldIds]
    if (ids.length === 0) return

    setCompacting(true)
    try {
      const res = await fetch('/api/chat/compact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, ids }),
      })
      if (!res.ok) return
      window.dispatchEvent(new CustomEvent('memory:updated'))
      setMessages(await fetchMessages())
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

    // 惰性建会话：草稿态（conversationId=null）首发时先创建。
    let convId = conversationId
    if (!convId) {
      try {
        const res = await fetch('/api/chat/conversations', { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { id: string }
        convId = body.id
        convIdRef.current = convId
        skipLoadForRef.current = convId  // 阻止随后的加载 effect 冲掉乐观占位
        onConversationCreated(convId)
      } catch {
        return // 建会话失败：无乐观占位可回滚，直接放弃
      }
    }

    await compactIfNeeded(convId)

    setMessages(prev => [
      ...prev,
      { role: 'user', content: message, status: 'done' },
      { role: 'assistant', content: '', status: 'generating', reasoning: '' },
    ])
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, message, docIds }),
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
            const json = JSON.parse(line.slice(6)) as { error?: string; text?: string; reasoning?: string; done?: boolean }
            if (json.error) throw new Error(json.error)
            if (json.reasoning) appendReasoningToLast(json.reasoning)
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
  }, [streaming, conversationId, compactIfNeeded, triggerNudge, onConversationCreated])

  const stopStreaming = useCallback((): void => {
    const cid = convIdRef.current
    // 1) 告诉服务端真正中断该会话的生成。
    fetch('/api/chat/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: cid }),
    }).catch(() => {})
    // 2) 中断本地 SSE 读取。
    abortRef.current?.abort()
    setStreaming(false)
    // 3) 末条生成中的 assistant 标为终态，解锁 UI（保留已生成部分）。
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      if (last && last.role === 'assistant' && last.status === 'generating') {
        updated[updated.length - 1] = { ...last, status: 'done' }
      }
      return updated
    })
  }, [])

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

  return {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming, togglePin,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/client && pnpm exec vitest run src/hooks/useChat.test.ts`
Expected: PASS（含新惰性创建用例）

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/hooks/useChat.ts packages/client/src/hooks/useChat.test.ts packages/client/src/types.ts
git commit -m "feat(client): useChat 按 conversationId 重构 + 惰性建会话 + stop 带会话"
```

---

## Task 6: ConversationList 组件 + 样式

**Files:**
- Create: `packages/client/src/components/ConversationList.tsx`
- Modify: `packages/client/src/App.module.css`（追加会话列表样式）

**Interfaces:**
- Consumes: Task 4 的 `Conversation` 类型
- Produces:
  - `interface ConversationListProps { conversations: Conversation[]; currentId: string | null; onSelect: (id: string) => void; onNew: () => void; onDelete: (id: string) => void }`
  - `function ConversationList(props: ConversationListProps): JSX.Element`

- [ ] **Step 1: 实现组件**

新建 `packages/client/src/components/ConversationList.tsx`：

```tsx
import type { Conversation } from '../types'
import styles from '../App.module.css'

interface ConversationListProps {
  conversations: Conversation[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function ConversationList({ conversations, currentId, onSelect, onNew, onDelete }: ConversationListProps) {
  return (
    <div className={styles.convPanel}>
      <button className={styles.newConvBtn} onClick={onNew}>＋ 新建对话</button>
      <div className={styles.convList}>
        {conversations.map(c => (
          <div
            key={c.id}
            className={`${styles.convItem} ${c.id === currentId ? styles.convItemActive : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {c.generating && <span className={styles.convDot} title="生成中" />}
            <span className={styles.convTitle}>{c.title}</span>
            <button
              className={styles.convDelete}
              title="删除对话"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm('确定删除这条对话？')) onDelete(c.id)
              }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 追加样式**

在 `packages/client/src/App.module.css` 末尾追加：

```css
/* === 会话列表 === */
.convPanel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.newConvBtn {
  padding: 8px 12px;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  text-align: left;
}
.newConvBtn:hover { background: rgba(0, 0, 0, 0.04); }
.convList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 40vh;
  overflow-y: auto;
}
.convItem {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.convItem:hover { background: rgba(0, 0, 0, 0.05); }
.convItemActive { background: rgba(0, 0, 0, 0.08); font-weight: 600; }
.convTitle {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.convDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  flex-shrink: 0;
  animation: convPulse 1.2s ease-in-out infinite;
}
@keyframes convPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.convDelete {
  border: none;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  font-size: 12px;
  padding: 2px;
}
.convItem:hover .convDelete { opacity: 0.6; }
.convDelete:hover { opacity: 1; }
```

- [ ] **Step 3: 类型检查**

Run: `cd packages/client && pnpm exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/ConversationList.tsx packages/client/src/App.module.css
git commit -m "feat(client): 新增 ConversationList 组件与侧边栏样式"
```

---

## Task 7: ChatView 接线，移除清空按钮

**Files:**
- Modify: `packages/client/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `useConversations`（Task 4）、重构后的 `useChat`（Task 5）、`ConversationList`（Task 6）

- [ ] **Step 1: 改 ChatView**

把 `packages/client/src/components/ChatView.tsx` 整体替换为：

```tsx
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { AuthUser } from '../hooks/useAuth'
import { useChat } from '../hooks/useChat'
import { useConversations } from '../hooks/useConversations'
import { useDocuments } from '../hooks/useDocuments'
import { Message } from './Message'
import { ChatInput } from './ChatInput'
import { ConversationList } from './ConversationList'
import { MemoryPanel } from './MemoryPanel'
import { EvalPanel } from './EvalPanel'
import styles from '../App.module.css'

interface Props {
  user: AuthUser
  onLogout: () => void
}

export function ChatView({ user, onLogout }: Props) {
  const convs = useConversations(user.id)
  const {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming, togglePin,
  } = useChat(user.id, convs.currentId, convs.onConversationCreated)
  const docs = useDocuments(user.id)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const limitReached = !user.unlimited && (user.remaining ?? 0) <= 0
  const generating = streaming || (messages[messages.length - 1]?.status === 'generating')

  // 发送后刷新会话列表：更新标题（首句自动生成）、生成中圆点、排序。
  const handleSend = (msg: string, docIds?: string[]): void => {
    void sendMessage(msg, docIds).then(() => convs.refresh())
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>D</span>
          <span className={styles.logoText}>DocMind</span>
        </div>

        <ConversationList
          conversations={convs.conversations}
          currentId={convs.currentId}
          onSelect={convs.selectConversation}
          onNew={convs.newConversation}
          onDelete={convs.deleteConversation}
        />

        <MemoryPanel />

        {user.isAdmin && <EvalPanel documents={docs.documents} />}
        {user.isAdmin && (
          <Link to="/traces" className={styles.tracesLink}>🔍 Traces</Link>
        )}
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>智能文档问答</h1>
            <p className={styles.subtitle}>
              {messages.length === 0
                ? '上传文档后即可基于文档内容提问'
                : `${messages.filter(m => m.role === 'user').length} 条对话`}
            </p>
          </div>
          <div className={styles.userBox}>
            <span className={styles.quota} title="剩余可发送消息数">
              {user.unlimited ? '∞ 无限' : `剩余 ${user.remaining ?? 0}/${user.limit}`}
            </span>
            {user.avatarUrl && (
              <img className={styles.avatar} src={user.avatarUrl} alt={user.username} />
            )}
            <span className={styles.userName}>{user.username}</span>
            <button className={styles.logoutBtn} onClick={onLogout}>
              退出
            </button>
          </div>
        </header>

        <div className={styles.messages}>
          {loading && <div className={styles.compactingBar}>正在加载对话…</div>}
          {loadError && <div className={styles.limitBar}>对话加载失败，请刷新重试。</div>}
          {messages.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>💬</div>
              <p className={styles.emptyTitle}>开始你的第一个问题</p>
              <p className={styles.emptyDesc}>
                现在可以直接和 AI 对话，上传文档后将基于文档内容回答
              </p>
              <div className={styles.suggestions}>
                {['你好，你能做什么？', '什么是 RAG？', '解释一下 Embedding'].map(s => (
                  <button
                    key={s}
                    className={styles.suggestion}
                    onClick={() => handleSend(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <Message
                key={i}
                index={i}
                role={msg.role}
                content={msg.content}
                isError={msg.isError}
                pinned={msg.pinned}
                compactedCount={msg.compactedCount}
                reasoning={msg.reasoning}
                isStreaming={
                  streaming && i === messages.length - 1 && msg.role === 'assistant'
                }
                onTogglePin={togglePin}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {compacting && (
          <div className={styles.compactingBar}>⚡ 正在压缩历史对话...</div>
        )}
        {limitReached && (
          <div className={styles.limitBar}>
            已达每位用户 {user.limit} 条消息上限，如需继续请联系管理员开通无限调用。
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          onStop={stopStreaming}
          streaming={generating || compacting}
          disabled={limitReached}
          documents={docs.documents}
          attachedIds={docs.attachedIds}
          uploading={docs.uploading}
          uploadError={docs.uploadError}
          onAttach={docs.attach}
          onDetach={docs.detach}
          onUpload={docs.upload}
          onRemoveDoc={docs.remove}
        />
      </main>
    </div>
  )
}
```

- [ ] **Step 2: 类型检查（含移除的 clearMessages/clearBtn 无残留）**

Run: `cd packages/client && pnpm exec tsc --noEmit`
Expected: 无错误

> 注：`App.module.css` 里 `.clearBtn`/`.sideBottom` 样式可保留（无引用不报错），本次不删以缩小改动面。

- [ ] **Step 3: 浏览器验证**

先确保 `.claude/launch.json` 有 client + server 配置；用 preview 工具起服务后：
- 侧边栏出现「＋ 新建对话」与会话列表。
- 发一条消息 → 出现新会话且标题为首句；再点「＋ 新建对话」→ 视图清空为草稿。
- 切换两条会话 → 各自历史独立。
- 在 A 生成中切到 B → A 会话项显示绿色"生成中"圆点；切回 A 内容补齐。
- 删除会话 → 从列表移除；删当前会话则跳到下一条。
- 用 `preview_console_logs`（level error）确认无报错；`preview_screenshot` 存证。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/ChatView.tsx
git commit -m "feat(client): ChatView 接入多会话，移除全局清空对话按钮"
```

---

## Task 8: 更新 CLAUDE.md 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新架构与 API 表**

在 `CLAUDE.md` 做以下改动（保持风格一致）：

1. `services/chatStore.ts` 条目描述改为提及"多会话（`conversations` 表 + `chat_messages.conversation_id`，seq 与 hasGenerating 按会话）"。
2. `hooks/useChat.ts` 描述补充"按 `conversationId` 加载与发送，草稿态惰性建会话"，并新增一行 `hooks/useConversations.ts` 描述会话列表/选中/新建/删除/生成中轮询。
3. API 端点表：
   - 新增 `GET /api/chat/conversations`、`POST /api/chat/conversations`、`DELETE /api/chat/conversations/:id`。
   - `GET /api/chat/messages` 改为带 `?conversationId=`。
   - `POST /api/chat/stream`、`/stop`、`/compact` 备注加 `conversationId`。
   - 删除 `DELETE /api/chat/messages` 一行。
4. 「Key Design Decisions」加一条"多会话：每用户多条独立会话，服务端按 `conversationId` 并发生成；客户端单路实时流 + 切回轮询恢复；配额与记忆/文档保持用户全局。参见 `docs/superpowers/specs/2026-07-05-multi-conversation-design.md`。"

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 反映多会话架构与 API"
```

---

## Self-Review

**1. Spec coverage：**
- 多会话形态（新建/切换/删除）→ Task 3（路由）+ Task 4/7（UI）✓
- 标题自动生成 → Task 1（`titleFromMessage`）+ Task 3（stream 首句设标题）✓
- 配额全局不变 → 未改 `canSend`/`incrementMessageCount`（Global Constraints + Task 3 保留）✓
- 记忆/文档全局共享 → 未加 conversation 维度（Global Constraints）✓
- 每会话并发生成 → Task 2（registry 按会话）+ Task 3（`hasGenerating(convId)`、按会话 register）✓
- 客户端单路流 + 轮询恢复 → Task 5（换会话 abort reader、runId 防护、poll）✓
- 生成中圆点 → Task 1（`listConversations.generating`）+ Task 4（2s 轮询）+ Task 6（`.convDot`）✓
- localStorage 记住当前会话 → Task 4 ✓
- 迁移/backfill → Task 1（`backfillConversations` + 测试）✓
- 删除当前/删除生成中会话边界 → Task 3（`abortGeneration` 先行）+ Task 4（选下一条）✓
- 越权 404 → Task 3 各路由校验 ✓
- 移除全局清空 → Task 3（删路由）+ Task 5（去 clearMessages）+ Task 7（去按钮）✓

**2. Placeholder scan：** 无 TBD/TODO；每个改动步骤含完整代码。Task 5 测试用例内对 stream mock 的 `body` 字段已在注记中修正为 `body: stream`。

**3. Type consistency：**
- `appendMessage(userId, conversationId, m)`、`getMessages(conversationId)`、`hasGenerating(conversationId)`、`replaceForCompaction(userId, conversationId, ids, summary)` 在 Task 1 定义，Task 3 调用一致 ✓
- `Conversation`（client）字段 `{ id, title, updated_at, message_count, generating }` 与 server `ConversationSummary` 一致；Task 4/6 使用一致 ✓
- `useChat(userId, conversationId, onConversationCreated)` 与 `UseChatReturn`（去 clearMessages）在 Task 4/5/7 一致 ✓
- `registerGeneration/unregisterGeneration/abortGeneration(conversationId)` Task 2 定义，Task 3 调用一致 ✓
