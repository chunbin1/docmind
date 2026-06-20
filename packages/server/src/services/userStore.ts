// packages/server/src/services/userStore.ts
import type { DB } from './memoryStore.js'

/** Default per-user message cap. Override with MESSAGE_LIMIT env. */
export const MESSAGE_LIMIT = Number(process.env.MESSAGE_LIMIT) || 10

export interface User {
  id: string
  github_id: number
  username: string
  avatar_url: string | null
  message_count: number
  /**
   * 0 = subject to MESSAGE_LIMIT, 1 = unlimited.
   * Intentionally has NO write API — flip it directly in the DB only:
   *   UPDATE users SET unlimited = 1 WHERE username = '...';
   */
  unlimited: number
  /**
   * 0 = normal user, 1 = admin (can see the eval module).
   * Like `unlimited`, intentionally has NO write API — flip it in the DB only:
   *   UPDATE users SET is_admin = 1 WHERE username = '...';
   */
  is_admin: number
  created_at: string
}

let _db: DB | null = null

export function initUserTables(db: DB): void {
  _db = db
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      github_id     INTEGER UNIQUE NOT NULL,
      username      TEXT NOT NULL,
      avatar_url    TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      unlimited     INTEGER NOT NULL DEFAULT 0,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );
  `)
  // Migrate DBs created before the admin flag existed.
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
  }
}

function db(): DB {
  if (!_db) throw new Error('userStore not initialized — call initUserTables() first')
  return _db
}

function genId(): string {
  return `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

/** Insert the user on first GitHub login, or refresh username/avatar on return. */
export function upsertGithubUser(p: {
  githubId: number
  username: string
  avatarUrl: string | null
}): User {
  const existing = db()
    .prepare('SELECT * FROM users WHERE github_id = ?')
    .get(p.githubId) as User | undefined

  if (existing) {
    db()
      .prepare('UPDATE users SET username = ?, avatar_url = ? WHERE github_id = ?')
      .run(p.username, p.avatarUrl, p.githubId)
    return { ...existing, username: p.username, avatar_url: p.avatarUrl }
  }

  const user: User = {
    id: genId(),
    github_id: p.githubId,
    username: p.username,
    avatar_url: p.avatarUrl,
    message_count: 0,
    unlimited: 0,
    is_admin: 0,
    created_at: new Date().toISOString(),
  }
  db()
    .prepare(
      `INSERT INTO users (id, github_id, username, avatar_url, message_count, unlimited, is_admin, created_at)
       VALUES (@id, @github_id, @username, @avatar_url, @message_count, @unlimited, @is_admin, @created_at)`,
    )
    .run(user)
  return user
}

export function getUserById(id: string): User | null {
  return (db().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined) ?? null
}

export function incrementMessageCount(id: string): void {
  db().prepare('UPDATE users SET message_count = message_count + 1 WHERE id = ?').run(id)
}

/** Whether this user is still allowed to send a message. */
export function canSend(user: User): boolean {
  return user.unlimited === 1 || user.message_count < MESSAGE_LIMIT
}

/** Remaining messages, or null when unlimited. */
export function remaining(user: User): number | null {
  if (user.unlimited === 1) return null
  return Math.max(0, MESSAGE_LIMIT - user.message_count)
}
