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
