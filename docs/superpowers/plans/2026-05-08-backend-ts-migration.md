# Backend TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all 8 backend source files from JavaScript ESM to TypeScript, with strict types throughout.

**Architecture:** Bottom-up conversion — shared types → leaf services (no internal deps) → services with deps → routes → entry point. `tsx` replaces `node` for running TS directly (no compile step needed for dev/prod). `tsc --noEmit` is the type-check gate after every task.

**Tech Stack:** TypeScript 5, Fastify 5, better-sqlite3, ChromaDB, Anthropic SDK, OpenAI SDK, tsx (runtime), Node.js ESM (`"type": "module"`)

---

## @types audit

Packages that ship their own types (no `@types/*` needed): `fastify`, `@fastify/cors`, `@fastify/multipart`, `@anthropic-ai/sdk`, `openai`, `chromadb`, `dotenv`.

Packages that need `@types/*`:
- `@types/node` — `process.env`, `fs`, `path`, top-level globals
- `@types/better-sqlite3` — `Database`, `Statement`

---

## File Map

| Current | After | Notes |
|---|---|---|
| *(new)* | `src/types.ts` | Shared domain types |
| *(new)* | `tsconfig.json` | TS compiler config |
| `src/services/embeddings.js` | `src/services/embeddings.ts` | No internal deps |
| `src/services/memoryStore.js` | `src/services/memoryStore.ts` | Depends on types.ts |
| `src/services/memoryVector.js` | `src/services/memoryVector.ts` | Depends on embeddings.ts, types.ts |
| `src/llm.js` | `src/llm.ts` | Depends on types.ts |
| `src/routes/documents.js` | `src/routes/documents.ts` | Simplest route |
| `src/routes/memory.js` | `src/routes/memory.ts` | Depends on both services |
| `src/routes/chat.js` | `src/routes/chat.ts` | Depends on llm + services |
| `src/index.js` | `src/index.ts` | Entry point |
| `package.json` | `package.json` | Scripts + devDeps |

Import paths stay as `.js` extensions throughout — TypeScript with `moduleResolution: "NodeNext"` resolves `.ts` files when the import says `.js`. This matches the existing code exactly.

---

## Task 0: Install TypeScript tooling and configure compiler

**Files:**
- Modify: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`

- [ ] **Step 1: Install devDependencies**

```bash
cd packages/server && pnpm add -D typescript tsx @types/node @types/better-sqlite3
```

Expected: `package.json` devDependencies gains `typescript`, `tsx`, `@types/node`, `@types/better-sqlite3`.

- [ ] **Step 2: Update package.json scripts**

In `packages/server/package.json`, replace the `"scripts"` block:

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "start": "tsx src/index.ts",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `packages/server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Run typecheck — expect zero errors (no .ts files yet)**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/server/tsconfig.json packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add TypeScript compiler and tsx runtime"
```

---

## Task 1: Create shared types file

**Files:**
- Create: `packages/server/src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
// packages/server/src/types.ts

export type LLMProvider = 'anthropic' | 'zhipu'

export type MessageRole = 'user' | 'assistant'

/** A message as sent by the client in request bodies */
export interface LLMMessage {
  role: MessageRole
  content: string
  pinned?: boolean
}

export interface StreamChatOptions {
  messages: LLMMessage[]
  system?: string
  maxTokens?: number
}

/** A persisted memory note row from SQLite */
export interface MemoryNote {
  id: string
  content: string
  source: string
  created_at: string
  chroma_id?: string | null
}

/** Parsed output from the compact LLM prompt */
export interface ParsedCompact {
  summary: string
  facts: string[]
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts
git commit -m "feat(server): add shared TypeScript type definitions"
```

---

## Task 2: Convert embeddings.js → embeddings.ts

**Files:**
- Create: `packages/server/src/services/embeddings.ts`
- Delete: `packages/server/src/services/embeddings.js`

- [ ] **Step 1: Create embeddings.ts**

```typescript
// packages/server/src/services/embeddings.ts
import OpenAI from 'openai'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.ZHIPU_API_KEY,
      baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    })
  }
  return _client
}

export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.ZHIPU_API_KEY)
}

/**
 * Embed a single text string.
 */
export async function embed(text: string): Promise<number[]> {
  const res = await getClient().embeddings.create({
    model: process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3',
    input: text,
  })
  return res.data[0].embedding
}

/**
 * Embed multiple texts in one API call.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const res = await getClient().embeddings.create({
    model: process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3',
    input: texts,
  })
  return res.data.map(d => d.embedding)
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/services/embeddings.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/embeddings.ts packages/server/src/services/embeddings.js
git commit -m "feat(server): convert embeddings service to TypeScript"
```

---

## Task 3: Convert memoryStore.js → memoryStore.ts

**Files:**
- Create: `packages/server/src/services/memoryStore.ts`
- Delete: `packages/server/src/services/memoryStore.js`

- [ ] **Step 1: Create memoryStore.ts**

```typescript
// packages/server/src/services/memoryStore.ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryNote } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const DB_PATH = join(DATA_DIR, 'memory.db')
const MAX_NOTES = 100
const MAX_NOTE_CHARS = 200

type DB = InstanceType<typeof Database>
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

function db(): DB {
  if (!_db) throw new Error('memoryStore not initialized — call initDb() first')
  return _db
}

function genId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

export function addNote(content: string, source = 'manual'): MemoryNote | null {
  const trimmed = String(content).trim().slice(0, MAX_NOTE_CHARS)
  if (!trimmed) return null

  const id = genId()
  const created_at = new Date().toISOString()

  db().prepare(
    'INSERT INTO memory_notes (id, content, source, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, trimmed, source, created_at)

  const countRow = db()
    .prepare('SELECT COUNT(*) as c FROM memory_notes')
    .get() as { c: number }

  if (countRow.c > MAX_NOTES) {
    const oldest = db()
      .prepare('SELECT id FROM memory_notes ORDER BY created_at ASC LIMIT ?')
      .all(countRow.c - MAX_NOTES) as { id: string }[]
    const del = db().prepare('DELETE FROM memory_notes WHERE id = ?')
    for (const row of oldest) del.run(row.id)
  }

  return { id, content: trimmed, source, created_at }
}

export function addNotes(contents: string[], source = 'manual'): MemoryNote[] {
  const insert = db().transaction((items: string[]) =>
    items.map(c => addNote(c, source)).filter((n): n is MemoryNote => n !== null),
  )
  return insert(contents)
}

export function deleteNote(id: string): void {
  db().prepare('DELETE FROM memory_notes WHERE id = ?').run(id)
}

export function clearAll(): void {
  db().prepare('DELETE FROM memory_notes').run()
}

export function getAllNotes(): MemoryNote[] {
  return db()
    .prepare('SELECT * FROM memory_notes ORDER BY created_at DESC')
    .all() as MemoryNote[]
}

export function searchFts(query: string, limit = 5): MemoryNote[] {
  if (!query?.trim()) return []
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
    `).all(safe, limit) as MemoryNote[]
  } catch {
    return []
  }
}

export function getTotalChars(): number {
  const row = db()
    .prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM memory_notes")
    .get() as { total: number }
  return row.total
}

export function formatForPrompt(notes: MemoryNote[]): string {
  if (!notes || notes.length === 0) return ''
  const lines = notes.map(n => `- ${n.content}`).join('\n')
  return `--- 相关记忆 ---\n${lines}`
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/services/memoryStore.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/memoryStore.ts packages/server/src/services/memoryStore.js
git commit -m "feat(server): convert memoryStore service to TypeScript"
```

---

## Task 4: Convert memoryVector.js → memoryVector.ts

**Files:**
- Create: `packages/server/src/services/memoryVector.ts`
- Delete: `packages/server/src/services/memoryVector.js`

- [ ] **Step 1: Create memoryVector.ts**

```typescript
// packages/server/src/services/memoryVector.ts
import { ChromaClient } from 'chromadb'
import { embed, isEmbeddingAvailable } from './embeddings.js'
import type { MemoryNote } from '../types.js'

const COLLECTION_NAME = 'docmind_memory'
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000'

// Infer Collection type from the client to avoid chromadb named-export fragility
type ChromaCollection = Awaited<ReturnType<ChromaClient['getOrCreateCollection']>>

let _client: ChromaClient | null = null
let _collection: ChromaCollection | null = null
let _available = false

export async function initCollection(): Promise<void> {
  if (!isEmbeddingAvailable()) {
    console.warn('[memoryVector] ZHIPU_API_KEY not set — ChromaDB memory disabled, using FTS5 fallback')
    return
  }
  try {
    _client = new ChromaClient({ path: CHROMA_URL })
    _collection = await _client.getOrCreateCollection({ name: COLLECTION_NAME })
    _available = true
    console.info(`[memoryVector] ChromaDB connected — collection "${COLLECTION_NAME}"`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] ChromaDB unavailable (${msg}) — FTS5 fallback active`)
  }
}

export function isVectorAvailable(): boolean {
  return _available
}

export async function upsertNote(note: MemoryNote): Promise<void> {
  if (!_available || !_collection) return
  try {
    const vector = await embed(note.content)
    await _collection.upsert({
      ids: [note.id],
      embeddings: [vector],
      documents: [note.content],
      metadatas: [{ source: note.source, created_at: note.created_at }],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] upsertNote failed: ${msg}`)
  }
}

export async function deleteNoteVector(id: string): Promise<void> {
  if (!_available || !_collection) return
  try {
    await _collection.delete({ ids: [id] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] deleteNoteVector failed: ${msg}`)
  }
}

export async function semanticSearch(query: string, topK = 3): Promise<MemoryNote[]> {
  if (!_available || !_collection || !query?.trim()) return []
  try {
    const vector = await embed(query)
    const results = await _collection.query({
      queryEmbeddings: [vector],
      nResults: topK,
    })
    const ids = results.ids[0] ?? []
    const docs = results.documents[0] ?? []
    const metas = results.metadatas[0] ?? []
    return ids.map((id, i) => ({
      id,
      content: docs[i] ?? '',
      source: String(metas[i]?.source ?? 'unknown'),
      created_at: String(metas[i]?.created_at ?? ''),
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] semanticSearch failed: ${msg}`)
    return []
  }
}

export async function clearCollection(): Promise<void> {
  if (!_available || !_client) return
  try {
    await _client.deleteCollection({ name: COLLECTION_NAME })
    _collection = await _client.getOrCreateCollection({ name: COLLECTION_NAME })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] clearCollection failed: ${msg}`)
  }
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/services/memoryVector.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/memoryVector.ts packages/server/src/services/memoryVector.js
git commit -m "feat(server): convert memoryVector service to TypeScript"
```

---

## Task 5: Convert llm.js → llm.ts

**Files:**
- Create: `packages/server/src/llm.ts`
- Delete: `packages/server/src/llm.js`

- [ ] **Step 1: Create llm.ts**

```typescript
// packages/server/src/llm.ts
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { LLMProvider, StreamChatOptions } from './types.js'

function detectProvider(): LLMProvider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase()
  if (explicit === 'anthropic' || explicit === 'zhipu') return explicit
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.ZHIPU_API_KEY) return 'zhipu'
  throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY or ZHIPU_API_KEY in .env')
}

export const PROVIDER: LLMProvider = detectProvider()

async function* streamAnthropic({
  messages,
  system,
  maxTokens = 2048,
}: StreamChatOptions): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const stream = await client.messages.stream({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system,
    messages: messages.map(({ role, content }) => ({ role, content })),
  })

  for await (const chunk of stream) {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'text_delta'
    ) {
      yield chunk.delta.text
    }
  }
}

function getZhipuModels(): string[] {
  const raw = process.env.ZHIPU_MODEL ?? 'glm-4-flash'
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function isQuotaError(err: unknown): boolean {
  const e = err as {
    status?: number
    code?: number | string
    message?: string
    error?: { code?: number | string; message?: string }
  }
  const code = e?.status ?? e?.code ?? e?.error?.code
  const msg = (e?.message ?? e?.error?.message ?? '').toLowerCase()
  return (
    code === 429 ||
    msg.includes('quota') ||
    msg.includes('insufficient') ||
    msg.includes('billing')
  )
}

type OpenAIRole = 'system' | 'user' | 'assistant'

async function* streamZhipu({
  messages,
  system,
  maxTokens = 2048,
}: StreamChatOptions): AsyncGenerator<string> {
  const client = new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })

  const chat: { role: OpenAIRole; content: string }[] = system
    ? [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role as OpenAIRole, content: m.content }))]
    : messages.map(m => ({ role: m.role as OpenAIRole, content: m.content }))

  const models = getZhipuModels()

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    try {
      const stream = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: chat,
      })

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content
        if (text) yield text
      }
      return
    } catch (err) {
      const hasNext = i < models.length - 1
      if (isQuotaError(err) && hasNext) {
        console.warn(`[llm] model "${model}" quota exhausted, switching to "${models[i + 1]}"`)
        continue
      }
      throw err
    }
  }
}

export function streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  if (PROVIDER === 'anthropic') return streamAnthropic(opts)
  if (PROVIDER === 'zhipu') return streamZhipu(opts)
  throw new Error(`Unknown provider: ${PROVIDER}`)
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/llm.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/llm.ts packages/server/src/llm.js
git commit -m "feat(server): convert LLM adapter to TypeScript"
```

---

## Task 6: Convert documents.js → documents.ts

**Files:**
- Create: `packages/server/src/routes/documents.ts`
- Delete: `packages/server/src/routes/documents.js`

- [ ] **Step 1: Create documents.ts**

```typescript
// packages/server/src/routes/documents.ts
import type { FastifyPluginAsync } from 'fastify'

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/documents', async () => {
    return { documents: [], message: 'Coming in milestone 2' }
  })
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/routes/documents.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/documents.ts packages/server/src/routes/documents.js
git commit -m "feat(server): convert documents route to TypeScript"
```

---

## Task 7: Convert memory.js → memory.ts

**Files:**
- Create: `packages/server/src/routes/memory.ts`
- Delete: `packages/server/src/routes/memory.js`

- [ ] **Step 1: Create memory.ts**

```typescript
// packages/server/src/routes/memory.ts
import type { FastifyPluginAsync } from 'fastify'
import {
  addNotes,
  deleteNote,
  clearAll,
  getAllNotes,
  searchFts,
  getTotalChars,
} from '../services/memoryStore.js'
import {
  upsertNote,
  deleteNoteVector,
  clearCollection,
  semanticSearch,
  isVectorAvailable,
} from '../services/memoryVector.js'

const MAX_CHARS = 20000

interface AddNotesBody {
  notes: string[]
  source?: string
}

interface SearchBody {
  query: string
  topK?: number
}

interface NoteParams {
  id: string
}

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/memory
  app.get('/memory', async () => {
    const notes = getAllNotes()
    const totalChars = getTotalChars()
    return { notes, totalChars, maxChars: MAX_CHARS, vectorEnabled: isVectorAvailable() }
  })

  // POST /api/memory/notes
  app.post<{ Body: AddNotesBody }>('/memory/notes', async (request, reply) => {
    const { notes: contents, source = 'manual' } = request.body ?? {}
    if (!Array.isArray(contents) || contents.length === 0) {
      return reply.status(400).send({ error: 'notes array required' })
    }
    const saved = addNotes(contents, source)
    for (const note of saved) {
      upsertNote(note).catch(() => {})
    }
    return { saved, totalChars: getTotalChars() }
  })

  // POST /api/memory/search
  app.post<{ Body: SearchBody }>('/memory/search', async (request, reply) => {
    const { query, topK = 5 } = request.body ?? {}
    if (!query || typeof query !== 'string') {
      return reply.status(400).send({ error: 'query string required' })
    }
    let results = await semanticSearch(query, topK)
    if (results.length === 0) results = searchFts(query, topK)
    return { results, vectorUsed: isVectorAvailable() && results.length > 0 }
  })

  // DELETE /api/memory/notes/:id
  app.delete<{ Params: NoteParams }>('/memory/notes/:id', async (request) => {
    const { id } = request.params
    deleteNote(id)
    deleteNoteVector(id).catch(() => {})
    return { ok: true }
  })

  // DELETE /api/memory (clear all)
  app.delete('/memory', async () => {
    clearAll()
    clearCollection().catch(() => {})
    return { ok: true }
  })
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/routes/memory.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/memory.ts packages/server/src/routes/memory.js
git commit -m "feat(server): convert memory routes to TypeScript"
```

---

## Task 8: Convert chat.js → chat.ts

**Files:**
- Create: `packages/server/src/routes/chat.ts`
- Delete: `packages/server/src/routes/chat.js`

- [ ] **Step 1: Create chat.ts**

```typescript
// packages/server/src/routes/chat.ts
import type { FastifyPluginAsync } from 'fastify'
import { streamChat, PROVIDER } from '../llm.js'
import { addNotes, searchFts } from '../services/memoryStore.js'
import { upsertNote, semanticSearch, isVectorAvailable } from '../services/memoryVector.js'
import type { LLMMessage, MemoryNote, ParsedCompact } from '../types.js'

const DEFAULT_SYSTEM =
  'You are a helpful assistant. Answer concisely and clearly. Use markdown formatting when appropriate.'

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3)
}

function trimHistoryByTokens(history: LLMMessage[], maxTokens = 6000): LLMMessage[] {
  const pinned = history.filter(m => m.pinned)
  const normal = history.filter(m => !m.pinned)
  const pinnedCost = pinned.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const budget = maxTokens - pinnedCost

  let used = 0
  let cutIndex = normal.length
  for (let i = normal.length - 1; i >= 0; i--) {
    const cost = estimateTokens(normal[i].content)
    if (used + cost > budget) { cutIndex = i + 1; break }
    used += cost
    if (i === 0) cutIndex = 0
  }
  return [...pinned, ...normal.slice(cutIndex)]
}

async function getRelevantNotes(query: string, topK = 3): Promise<MemoryNote[]> {
  if (isVectorAvailable()) {
    const results = await semanticSearch(query, topK)
    if (results.length > 0) return results
  }
  return searchFts(query, topK)
}

function persistFacts(facts: string[], source: string): MemoryNote[] {
  const saved = addNotes(facts, source)
  for (const note of saved) {
    upsertNote(note).catch(() => {})
  }
  return saved
}

function parseCompactOutput(raw: string): ParsedCompact {
  const summaryMatch = raw.match(/##SUMMARY##\s*([\s\S]*?)(?=##FACTS##|$)/)
  const factsMatch = raw.match(/##FACTS##\s*([\s\S]*)$/)

  const summary = summaryMatch?.[1]?.trim() ?? raw.trim()
  const facts =
    factsMatch?.[1]
      ?.split('\n')
      .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
      .filter(l => l.length > 3 && l.length <= 200)
      .slice(0, 5) ?? []

  return { summary, facts }
}

interface StreamBody {
  message: string
  history?: LLMMessage[]
  systemPrompt?: string
}

interface CompactBody {
  messages: LLMMessage[]
}

interface NudgeBody {
  messages: LLMMessage[]
}

type SSEPayload =
  | { text: string }
  | { done: true }
  | { error: string }

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', provider: PROVIDER }))

  // POST /api/chat/stream — SSE streaming chat
  app.post<{ Body: StreamBody }>('/chat/stream', async (request, reply) => {
    const { message, history = [], systemPrompt } = request.body

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'message is required' })
    }

    const relevantNotes = await getRelevantNotes(message)
    const memSection = relevantNotes.length
      ? `--- 相关记忆 ---\n${relevantNotes.map(n => `- ${n.content}`).join('\n')}`
      : ''

    const finalSystem = [systemPrompt ?? DEFAULT_SYSTEM, memSection]
      .filter(Boolean)
      .join('\n\n')

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (payload: SSEPayload): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const messages: LLMMessage[] = [
      ...trimHistoryByTokens(history),
      { role: 'user', content: message },
    ]

    try {
      const stream = streamChat({ messages, system: finalSystem })
      for await (const text of stream) send({ text })
      send({ done: true })
    } catch (err) {
      app.log.error(err)
      const msg = err instanceof Error ? err.message : 'Unknown error'
      send({ error: msg })
    } finally {
      reply.raw.end()
    }
  })

  // POST /api/chat/compact — summarise old messages, extract facts
  app.post<{ Body: CompactBody }>('/chat/compact', async (request, reply) => {
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages is required' })
    }

    const historyText = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n')

    let rawOutput = ''
    const stream = streamChat({
      messages: [{
        role: 'user',
        content: `请分析以下对话，完成两项任务：

1. 生成对话摘要（300字以内，保留关键信息和用户意图）
2. 提取值得长期记忆的重要事实（最多5条，每条50字以内，每行一条）

请严格按以下格式输出（不要添加其他内容）：

##SUMMARY##
[摘要内容]

##FACTS##
[事实1]
[事实2]

对话内容：
${historyText}`,
      }],
      system: '你是对话分析助手，专注提炼关键信息和重要事实。',
      maxTokens: 1024,
    })
    for await (const text of stream) rawOutput += text

    const { summary, facts } = parseCompactOutput(rawOutput)
    if (facts.length > 0) persistFacts(facts, 'compact')

    return { summary, facts }
  })

  // POST /api/chat/nudge — background fact extraction every N turns
  app.post<{ Body: NudgeBody }>('/chat/nudge', async (request, reply) => {
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages required' })
    }

    const historyText = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n')

    let rawFacts = ''
    try {
      const stream = streamChat({
        messages: [{
          role: 'user',
          content: `请从以下对话中提取值得长期记忆的重要事实（用户偏好、关键决策、重要信息），每条独立一行，最多5条，每条不超过50字。如果没有值得记住的，返回空内容。

对话：
${historyText}`,
        }],
        system: '你是记忆提取助手，只输出事实条目，不解释，不加序号。',
        maxTokens: 300,
      })
      for await (const text of stream) rawFacts += text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      app.log.warn(`nudge LLM error: ${msg}`)
      return { extracted: 0 }
    }

    const facts = rawFacts
      .split('\n')
      .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
      .filter(l => l.length > 3 && l.length <= 200)
      .slice(0, 5)

    if (facts.length > 0) persistFacts(facts, 'nudge')
    return { extracted: facts.length }
  })
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/routes/chat.js
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/chat.ts packages/server/src/routes/chat.js
git commit -m "feat(server): convert chat routes to TypeScript"
```

---

## Task 9: Convert index.js → index.ts

**Files:**
- Create: `packages/server/src/index.ts`
- Delete: `packages/server/src/index.js`

- [ ] **Step 1: Create index.ts**

```typescript
// packages/server/src/index.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import 'dotenv/config'

import { chatRoutes } from './routes/chat.js'
import { documentRoutes } from './routes/documents.js'
import { memoryRoutes } from './routes/memory.js'
import { initDb } from './services/memoryStore.js'
import { initCollection } from './services/memoryVector.js'

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
})

await app.register(cors, {
  origin: ['http://localhost:5173', 'http://localhost:4173'],
})

await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024 },
})

initDb()
await initCollection()

await app.register(chatRoutes, { prefix: '/api' })
await app.register(documentRoutes, { prefix: '/api' })
await app.register(memoryRoutes, { prefix: '/api' })

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

const port = Number(process.env.PORT) || 3001

try {
  await app.listen({ port, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/server/src/index.js
```

- [ ] **Step 3: Run full typecheck — zero errors**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/index.js
git commit -m "feat(server): convert entry point to TypeScript"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full type check**

```bash
cd packages/server && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 2: Verify no .js source files remain**

```bash
find packages/server/src -name "*.js" | grep -v node_modules
```

Expected: no output.

- [ ] **Step 3: Start the dev server**

```bash
npm run dev:server   # from repo root
```

Expected output includes:
```
[memoryStore] ...
Server listening at http://0.0.0.0:3001
```

- [ ] **Step 4: Smoke test the API**

```bash
curl http://localhost:3001/health
```

Expected: `{"status":"ok","timestamp":"..."}`.

```bash
curl -s -X POST http://localhost:3001/api/chat/compact \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]}' | head -c 200
```

Expected: JSON with `summary` and `facts` fields.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(server): complete backend TypeScript migration"
```

---

## Self-Review

**Spec coverage:**
- ✅ All 8 source files converted (index, llm, chat, memory, documents, embeddings, memoryStore, memoryVector)
- ✅ Shared types centralised in `types.ts`
- ✅ `tsx` runtime replaces `node` — no separate compile step
- ✅ `tsc --noEmit` typecheck script added
- ✅ `strict: true` throughout
- ✅ Node.js ESM module resolution preserved (`moduleResolution: "NodeNext"`, `.js` import paths)

**Placeholder scan:** No TBDs. All code blocks are complete and runnable.

**Type consistency:**
- `LLMMessage` defined in `types.ts`, used in `llm.ts` and all three route files — consistent
- `MemoryNote` defined in `types.ts`, used in `memoryStore.ts`, `memoryVector.ts`, `chat.ts`, `memory.ts` — consistent
- `ParsedCompact` defined in `types.ts`, returned by `parseCompactOutput` in `chat.ts` — consistent
- `FastifyPluginAsync` used in all three route files — consistent
- `StreamChatOptions.messages` typed as `LLMMessage[]`; `streamChat` call sites all pass `LLMMessage[]` — consistent
