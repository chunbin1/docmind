// packages/server/src/services/memoryStore.ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryNote } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const DB_PATH = join(DATA_DIR, 'memory.db')
const MAX_NOTES = 100
const MAX_NOTE_CHARS = 200

export type DB = InstanceType<typeof Database>
let _db: DB | null = null

export function initDb(): DB {
  mkdirSync(DATA_DIR, { recursive: true })
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_notes (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_id    TEXT,
      chroma_id  TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
      content,
      content='memory_notes',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS notes_ai
    AFTER INSERT ON memory_notes BEGIN
      INSERT INTO memory_notes_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_ad
    AFTER DELETE ON memory_notes BEGIN
      INSERT INTO memory_notes_fts(memory_notes_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
  `)

  // Migrate older DBs created before per-user isolation (rows keep NULL user_id
  // and become invisible to every user, which is the intended fresh-start behaviour).
  const cols = _db.prepare('PRAGMA table_info(memory_notes)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'user_id')) {
    _db.exec('ALTER TABLE memory_notes ADD COLUMN user_id TEXT')
  }

  return _db
}

function db(): DB {
  if (!_db) throw new Error('memoryStore not initialized — call initDb() first')
  return _db
}

function genId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

export function addNote(userId: string, content: string, source = 'manual'): MemoryNote | null {
  const trimmed = String(content).trim().slice(0, MAX_NOTE_CHARS)
  if (!trimmed) return null

  const id = genId()
  const created_at = new Date().toISOString()

  db().prepare(
    'INSERT INTO memory_notes (id, content, source, created_at, user_id) VALUES (?, ?, ?, ?, ?)',
  ).run(id, trimmed, source, created_at, userId)

  // Eviction is per-user: keep at most MAX_NOTES notes for this user.
  const countRow = db()
    .prepare('SELECT COUNT(*) as c FROM memory_notes WHERE user_id = ?')
    .get(userId) as { c: number }

  if (countRow.c > MAX_NOTES) {
    const oldest = db()
      .prepare('SELECT id FROM memory_notes WHERE user_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(userId, countRow.c - MAX_NOTES) as { id: string }[]
    const del = db().prepare('DELETE FROM memory_notes WHERE id = ?')
    for (const row of oldest) del.run(row.id)
  }

  return { id, content: trimmed, source, created_at }
}

export function addNotes(userId: string, contents: string[], source = 'manual'): MemoryNote[] {
  const insert = db().transaction((items: string[]) =>
    items.map(c => addNote(userId, c, source)).filter((n): n is MemoryNote => n !== null),
  )
  return insert(contents)
}

/** Delete a note only if it belongs to the requesting user. */
export function deleteNote(userId: string, id: string): void {
  db().prepare('DELETE FROM memory_notes WHERE id = ? AND user_id = ?').run(id, userId)
}

export function clearAll(userId: string): void {
  db().prepare('DELETE FROM memory_notes WHERE user_id = ?').run(userId)
}

export function getAllNotes(userId: string): MemoryNote[] {
  return db()
    .prepare('SELECT * FROM memory_notes WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as MemoryNote[]
}

export function searchFts(userId: string, query: string, limit = 5): MemoryNote[] {
  if (!query?.trim()) return []
  const safe = query.replace(/["*()]/g, ' ').trim()
  if (!safe) return []
  try {
    return db().prepare(`
      SELECT n.*
      FROM memory_notes n
      JOIN memory_notes_fts f ON n.rowid = f.rowid
      WHERE memory_notes_fts MATCH ? AND n.user_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(safe, userId, limit) as MemoryNote[]
  } catch {
    return []
  }
}

export function getTotalChars(userId: string): number {
  const row = db()
    .prepare('SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM memory_notes WHERE user_id = ?')
    .get(userId) as { total: number }
  return row.total
}

export function formatForPrompt(notes: MemoryNote[]): string {
  if (!notes || notes.length === 0) return ''
  const lines = notes.map(n => `- ${n.content}`).join('\n')
  return `--- 相关记忆 ---\n${lines}`
}
