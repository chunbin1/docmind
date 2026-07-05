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
