/**
 * Memory Notes Store — SQLite-backed persistent storage with FTS5 search.
 *
 * Schema:
 *   memory_notes      — structured rows
 *   memory_notes_fts  — FTS5 virtual table for keyword search (fallback)
 *
 * Limits: max 100 notes, single note ≤ 200 chars.
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'

const DATA_DIR = join(process.cwd(), 'data')
const DB_PATH = join(DATA_DIR, 'memory.db')
const MAX_NOTES = 100
const MAX_NOTE_CHARS = 200

let _db = null

export function initDb() {
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

  return _db
}

function db() {
  if (!_db) throw new Error('memoryStore not initialized — call initDb() first')
  return _db
}

function genId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

/**
 * Add a single note. Evicts oldest notes if over MAX_NOTES.
 * @returns {object} the saved note row
 */
export function addNote(content, source = 'manual') {
  const trimmed = String(content).trim().slice(0, MAX_NOTE_CHARS)
  if (!trimmed) return null

  const id = genId()
  const created_at = new Date().toISOString()

  db().prepare(
    'INSERT INTO memory_notes (id, content, source, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, trimmed, source, created_at)

  // Evict oldest if over limit
  const count = db().prepare('SELECT COUNT(*) as c FROM memory_notes').get().c
  if (count > MAX_NOTES) {
    const oldest = db().prepare(
      'SELECT id FROM memory_notes ORDER BY created_at ASC LIMIT ?'
    ).all(count - MAX_NOTES)
    const del = db().prepare('DELETE FROM memory_notes WHERE id = ?')
    for (const row of oldest) del.run(row.id)
  }

  return { id, content: trimmed, source, created_at }
}

/**
 * Add multiple notes in a transaction.
 * @param {string[]} contents
 * @param {string} source
 * @returns {object[]} saved note rows
 */
export function addNotes(contents, source = 'manual') {
  const insert = db().transaction((items) => {
    return items
      .map(c => addNote(c, source))
      .filter(Boolean)
  })
  return insert(contents)
}

export function deleteNote(id) {
  db().prepare('DELETE FROM memory_notes WHERE id = ?').run(id)
}

export function clearAll() {
  db().prepare('DELETE FROM memory_notes').run()
}

export function getAllNotes() {
  return db().prepare(
    'SELECT * FROM memory_notes ORDER BY created_at DESC'
  ).all()
}

/**
 * FTS5 keyword search — used as fallback when ChromaDB is unavailable.
 * @param {string} query
 * @param {number} limit
 * @returns {object[]}
 */
export function searchFts(query, limit = 5) {
  if (!query || !query.trim()) return []
  // Sanitize query: remove FTS5 special chars to avoid syntax errors
  const safe = query.replace(/["*()]/g, ' ').trim()
  if (!safe) return []
  try {
    return db().prepare(`
      SELECT n.*
      FROM memory_notes n
      JOIN memory_notes_fts f ON n.rowid = f.rowid
      WHERE memory_notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safe, limit)
  } catch {
    return []
  }
}

export function getTotalChars() {
  const row = db().prepare(
    "SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM memory_notes"
  ).get()
  return row.total
}

/**
 * Format notes for injection into system prompt.
 * Returns empty string when no notes exist.
 */
export function formatForPrompt(notes) {
  if (!notes || notes.length === 0) return ''
  const lines = notes.map(n => `- ${n.content}`).join('\n')
  return `--- 相关记忆 ---\n${lines}`
}
