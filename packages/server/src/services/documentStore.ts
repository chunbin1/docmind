// packages/server/src/services/documentStore.ts
import type { DB } from './memoryStore.js'
import type { Document } from '../types.js'

let _db: DB | null = null

export function initDocumentTables(db: DB): void {
  _db = db
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      user_id     TEXT
    );
  `)
  // Migrate DBs created before per-user isolation (old rows keep NULL user_id).
  const cols = db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN user_id TEXT')
  }
}

function db(): DB {
  if (!_db) throw new Error('documentStore not initialized — call initDocumentTables() first')
  return _db
}

function genDocId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export function saveDocument(userId: string, opts: {
  filename: string
  size_bytes: number
  chunk_count: number
}): Document {
  const id = genDocId()
  const created_at = new Date().toISOString()
  db().prepare(
    'INSERT INTO documents (id, filename, size_bytes, chunk_count, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, opts.filename, opts.size_bytes, opts.chunk_count, created_at, userId)
  return { id, ...opts, created_at }
}

export function getAllDocuments(userId: string): Document[] {
  return db()
    .prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Document[]
}

/** Delete only if the document belongs to the requesting user. */
export function deleteDocument(userId: string, id: string): void {
  db().prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(id, userId)
}

export function getDocument(userId: string, id: string): Document | null {
  return (
    (db().prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(id, userId) as Document) ??
    null
  )
}
