# PDF Document RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can upload PDF files, attach them to a conversation, and ask questions about the content via semantic search over document chunks.

**Architecture:** pdf-parse extracts text → custom recursive chunker splits into 500-char pieces → Zhipu embedding-3 vectorizes → ChromaDB `docmind_docs` stores chunks → at chat time, top-3 chunks retrieved by doc_ids filter injected into system prompt. Metadata in SQLite. Frontend adds paperclip icon to ChatInput with DocumentPicker popover.

**Tech Stack:** pdf-parse, better-sqlite3, chromadb, Zhipu embedding-3 API, React 19, TypeScript (NodeNext backend / bundler frontend)

---

## File Map

**Create (backend):**
- `packages/server/src/services/documentStore.ts` — SQLite: documents table CRUD
- `packages/server/src/services/documentVector.ts` — ChromaDB: upsert/search/delete doc chunks
- `packages/server/src/services/pdfParser.ts` — pdf-parse wrapper + recursive chunker

**Modify (backend):**
- `packages/server/src/types.ts` — add `Document`, `DocumentChunk`
- `packages/server/src/routes/documents.ts` — replace placeholder with real endpoints
- `packages/server/src/routes/chat.ts` — add `docIds` to StreamBody, inject doc chunks
- `packages/server/src/index.ts` — init documentVector collection on startup

**Create (frontend):**
- `packages/client/src/hooks/useDocuments.ts` — fetch list, upload, track attached docIds
- `packages/client/src/components/DocumentChip.tsx` — small removable tag
- `packages/client/src/components/DocumentChip.module.css`
- `packages/client/src/components/DocumentPicker.tsx` — popover with list + upload
- `packages/client/src/components/DocumentPicker.module.css`

**Modify (frontend):**
- `packages/client/src/types.ts` — add `Document`
- `packages/client/src/components/ChatInput.tsx` — paperclip icon + chips + docIds on send
- `packages/client/src/components/ChatInput.module.css` — styles for new elements
- `packages/client/src/hooks/useChat.ts` — accept `docIds` in `sendMessage`

---

## Task 1: Add shared TypeScript types

**Files:**
- Modify: `packages/server/src/types.ts`
- Modify: `packages/client/src/types.ts`

- [ ] **Step 1: Add Document and DocumentChunk to server types**

Open `packages/server/src/types.ts` and append:

```typescript
/** A persisted document row from SQLite */
export interface Document {
  id: string
  filename: string
  size_bytes: number
  chunk_count: number
  created_at: string
}

/** A chunk returned from ChromaDB semantic search */
export interface DocumentChunk {
  doc_id: string
  filename: string
  chunk_index: number
  content: string
  distance: number
}
```

- [ ] **Step 2: Add Document to client types**

Open `packages/client/src/types.ts` and append:

```typescript
/** A persisted document available for attachment */
export interface Document {
  id: string
  filename: string
  size_bytes: number
  chunk_count: number
  created_at: string
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/server && pnpm exec tsc --noEmit
cd packages/client && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/types.ts packages/client/src/types.ts
git commit -m "feat(types): add Document and DocumentChunk types"
```

---

## Task 2: documentStore.ts — SQLite service

**Files:**
- Create: `packages/server/src/services/documentStore.ts`

- [ ] **Step 1: Create the file**

```typescript
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
      created_at  TEXT NOT NULL
    );
  `)
}

function db(): DB {
  if (!_db) throw new Error('documentStore not initialized — call initDocumentTables() first')
  return _db
}

function genDocId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export function saveDocument(opts: {
  filename: string
  size_bytes: number
  chunk_count: number
}): Document {
  const id = genDocId()
  const created_at = new Date().toISOString()
  db().prepare(
    'INSERT INTO documents (id, filename, size_bytes, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, opts.filename, opts.size_bytes, opts.chunk_count, created_at)
  return { id, ...opts, created_at }
}

export function getAllDocuments(): Document[] {
  return db()
    .prepare('SELECT * FROM documents ORDER BY created_at DESC')
    .all() as Document[]
}

export function deleteDocument(id: string): void {
  db().prepare('DELETE FROM documents WHERE id = ?').run(id)
}

export function getDocument(id: string): Document | null {
  return (db().prepare('SELECT * FROM documents WHERE id = ?').get(id) as Document) ?? null
}
```

- [ ] **Step 2: Export DB type from memoryStore so documentStore can reuse it**

Open `packages/server/src/services/memoryStore.ts` and add `export` to the DB type alias (line ~12):

```typescript
// Change this line:
type DB = InstanceType<typeof Database>
// To:
export type DB = InstanceType<typeof Database>
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/server && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/documentStore.ts packages/server/src/services/memoryStore.ts
git commit -m "feat(server): add documentStore SQLite service"
```

---

## Task 3: pdfParser.ts — PDF parsing and chunking

**Files:**
- Create: `packages/server/src/services/pdfParser.ts`

- [ ] **Step 1: Check pdf-parse types**

```bash
ls packages/server/node_modules/pdf-parse/index.d.ts 2>/dev/null || echo "no types"
```

If "no types", install them:

```bash
cd packages/server && pnpm add -D @types/pdf-parse
```

- [ ] **Step 2: Create pdfParser.ts**

```typescript
// packages/server/src/services/pdfParser.ts
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface ParseError {
  code: 'TOO_LARGE' | 'EMPTY_TEXT' | 'PARSE_FAILED'
  message: string
}

export interface ParseResult {
  text: string
  pages: number
}

export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  if (buffer.length > MAX_FILE_BYTES) {
    throw { code: 'TOO_LARGE', message: '文件超过 10MB 限制' } satisfies ParseError
  }

  let result: { text: string; numpages: number }
  try {
    result = await pdfParse(buffer)
  } catch {
    throw { code: 'PARSE_FAILED', message: 'PDF 解析失败，可能是加密或损坏文件' } satisfies ParseError
  }

  const text = result.text.trim()
  if (!text) {
    throw { code: 'EMPTY_TEXT', message: '该 PDF 为扫描件，暂不支持' } satisfies ParseError
  }

  return { text, pages: result.numpages }
}

export interface ChunkOptions {
  chunkSize?: number
  overlap?: number
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const { chunkSize = 500, overlap = 50 } = opts
  const separators = ['\n\n', '\n', ' ', '']
  return recursiveSplit(text, separators, chunkSize, overlap)
}

function recursiveSplit(
  text: string,
  separators: string[],
  chunkSize: number,
  overlap: number,
): string[] {
  if (text.length <= chunkSize) return text.trim() ? [text.trim()] : []

  const [sep, ...rest] = separators

  // No separator left — hard split by character
  if (sep === undefined) {
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize))
      start += chunkSize - overlap
    }
    return chunks
  }

  const parts = sep ? text.split(sep) : text.split('')

  // If this separator doesn't split the text, try next
  if (parts.length === 1) return recursiveSplit(text, rest, chunkSize, overlap)

  const chunks: string[] = []
  let current = ''

  for (const part of parts) {
    const candidate = current ? current + sep + part : part
    if (candidate.length <= chunkSize) {
      current = candidate
    } else {
      if (current.trim()) chunks.push(current.trim())
      // If a single part is too long, recurse with finer separators
      if (part.length > chunkSize) {
        chunks.push(...recursiveSplit(part, rest, chunkSize, overlap))
        current = ''
      } else {
        current = part
      }
    }
  }
  if (current.trim()) chunks.push(current.trim())

  // Apply overlap: prepend tail of previous chunk to next
  if (overlap > 0 && chunks.length > 1) {
    return chunks.map((chunk, i) => {
      if (i === 0) return chunk
      const prev = chunks[i - 1]
      const tail = prev.slice(-overlap)
      return (tail + ' ' + chunk).trim()
    })
  }

  return chunks
}
```

- [ ] **Step 3: Verify chunking logic manually**

```bash
cd packages/server && node --input-type=module <<'EOF'
import { chunkText } from './src/services/pdfParser.js'
const text = 'A'.repeat(600) + '\n\n' + 'B'.repeat(300)
const chunks = chunkText(text, { chunkSize: 500, overlap: 50 })
console.log('chunk count:', chunks.length)
console.log('chunk 0 length:', chunks[0].length)
console.log('overlap present:', chunks[1].startsWith('A'))
EOF
```

Expected output:
```
chunk count: 3
chunk 0 length: 500
overlap present: true
```

- [ ] **Step 4: Typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/pdfParser.ts
git commit -m "feat(server): add PDF parser and recursive text chunker"
```

---

## Task 4: documentVector.ts — ChromaDB service

**Files:**
- Create: `packages/server/src/services/documentVector.ts`

- [ ] **Step 1: Create the file**

```typescript
// packages/server/src/services/documentVector.ts
import { ChromaClient } from 'chromadb'
import { embedBatch, isEmbeddingAvailable } from './embeddings.js'
import type { DocumentChunk } from '../types.js'

const COLLECTION_NAME = 'docmind_docs'
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000'

type ChromaCollection = Awaited<ReturnType<ChromaClient['getOrCreateCollection']>>

let _client: ChromaClient | null = null
let _collection: ChromaCollection | null = null
let _available = false

export async function initDocCollection(): Promise<void> {
  if (!isEmbeddingAvailable()) {
    console.warn('[documentVector] Embedding not available — document semantic search disabled')
    return
  }
  try {
    _client = new ChromaClient({ path: CHROMA_URL })
    _collection = await _client.getOrCreateCollection({ name: COLLECTION_NAME })
    _available = true
    console.info(`[documentVector] ChromaDB connected — collection "${COLLECTION_NAME}"`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] ChromaDB unavailable (${msg}) — document search disabled`)
  }
}

export function isDocVectorAvailable(): boolean {
  return _available
}

export async function upsertChunks(
  docId: string,
  filename: string,
  chunks: string[],
): Promise<void> {
  if (!_available || !_collection || chunks.length === 0) return

  const embeddings = await embedBatch(chunks)
  const ids = chunks.map((_, i) => `${docId}_chunk_${i}`)
  const metadatas = chunks.map((_, i) => ({ doc_id: docId, filename, chunk_index: i }))

  await _collection.upsert({
    ids,
    embeddings,
    documents: chunks,
    metadatas,
  })
}

export async function searchChunks(
  query: string,
  docIds: string[],
  topK = 3,
): Promise<DocumentChunk[]> {
  if (!_available || !_collection || docIds.length === 0) return []

  try {
    const queryEmbedding = (await embedBatch([query]))[0]
    const results = await _collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where: { doc_id: { $in: docIds } },
    })

    const ids = results.ids[0] ?? []
    const documents = results.documents[0] ?? []
    const metadatas = results.metadatas[0] ?? []
    const distances = results.distances?.[0] ?? []

    return ids.map((_, i) => ({
      doc_id: String((metadatas[i] as Record<string, unknown>)?.doc_id ?? ''),
      filename: String((metadatas[i] as Record<string, unknown>)?.filename ?? ''),
      chunk_index: Number((metadatas[i] as Record<string, unknown>)?.chunk_index ?? 0),
      content: documents[i] ?? '',
      distance: distances[i] ?? 0,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] searchChunks failed: ${msg}`)
    return []
  }
}

export async function deleteByDocId(docId: string): Promise<void> {
  if (!_available || !_collection) return
  try {
    await _collection.delete({ where: { doc_id: { $eq: docId } } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] deleteByDocId failed: ${msg}`)
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/server && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/documentVector.ts
git commit -m "feat(server): add documentVector ChromaDB service for doc chunks"
```

---

## Task 5: routes/documents.ts — API endpoints

**Files:**
- Modify: `packages/server/src/routes/documents.ts`

- [ ] **Step 1: Replace the placeholder with full implementation**

```typescript
// packages/server/src/routes/documents.ts
import type { FastifyPluginAsync } from 'fastify'
import { parsePdf, chunkText } from '../services/pdfParser.js'
import { saveDocument, getAllDocuments, deleteDocument, getDocument } from '../services/documentStore.js'
import { upsertChunks, deleteByDocId, isDocVectorAvailable } from '../services/documentVector.js'
import type { ParseError } from '../services/pdfParser.js'

function isParseError(e: unknown): e is ParseError {
  return typeof e === 'object' && e !== null && 'code' in e
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents — list all documents
  app.get('/documents', async () => {
    const documents = getAllDocuments()
    return { documents }
  })

  // POST /api/documents — upload a PDF
  app.post('/documents', async (request, reply) => {
    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' })
    }

    const mimetype = data.mimetype
    if (mimetype !== 'application/pdf') {
      return reply.status(400).send({ error: '只支持 PDF 文件' })
    }

    const buffer = await data.toBuffer()

    let parseResult: Awaited<ReturnType<typeof parsePdf>>
    try {
      parseResult = await parsePdf(buffer)
    } catch (err) {
      if (isParseError(err)) {
        const status = err.code === 'EMPTY_TEXT' ? 422 : 400
        return reply.status(status).send({ error: err.message })
      }
      return reply.status(500).send({ error: 'PDF 处理失败' })
    }

    const chunks = chunkText(parseResult.text)
    const doc = saveDocument({
      filename: data.filename,
      size_bytes: buffer.length,
      chunk_count: chunks.length,
    })

    if (isDocVectorAvailable()) {
      upsertChunks(doc.id, doc.filename, chunks).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        app.log.warn(`[documents] upsertChunks failed for ${doc.id}: ${msg}`)
      })
    }

    return { document: doc }
  })

  // DELETE /api/documents/:id
  app.delete<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    const { id } = request.params
    const doc = getDocument(id)
    if (!doc) {
      return reply.status(404).send({ error: 'Document not found' })
    }

    await deleteByDocId(id)
    deleteDocument(id)

    return { success: true }
  })
}
```

- [ ] **Step 2: Verify server starts without errors**

```bash
curl -s http://localhost:3001/api/documents
```

Expected:
```json
{"documents":[]}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/server && pnpm exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/documents.ts
git commit -m "feat(server): implement document upload/list/delete endpoints"
```

---

## Task 6: Wire up in index.ts

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add initDocCollection and initDocumentTables**

Open `packages/server/src/index.ts`. Make these changes:

```typescript
// Add imports after existing service imports:
import { initDocumentTables } from './services/documentStore.js'
import { initDocCollection } from './services/documentVector.js'
```

Then in the startup section, after `initDb()`:

```typescript
// Change:
initDb()
await initCollection()

// To:
const sqliteDb = initDb()
initDocumentTables(sqliteDb)
await initCollection()
await initDocCollection()
```

Also update `initDb()` return type usage — it already returns `DB`. `initDb` returns the `DB` instance so we can pass it to `initDocumentTables`.

- [ ] **Step 2: Verify server restarts and logs show both ChromaDB collections**

Check logs:
```
[memoryVector] ChromaDB connected — collection "docmind_memory"
[documentVector] ChromaDB connected — collection "docmind_docs"
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/server && pnpm exec tsc --noEmit
```

- [ ] **Step 4: End-to-end upload test**

```bash
# Use any small PDF file. If you don't have one, create a test PDF:
# (Or use any PDF from ~/Downloads)
curl -s -X POST http://localhost:3001/api/documents \
  -F "file=@/path/to/test.pdf" | python3 -m json.tool
```

Expected:
```json
{
  "document": {
    "id": "doc_...",
    "filename": "test.pdf",
    "size_bytes": 12345,
    "chunk_count": 8,
    "created_at": "2026-05-10T..."
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): wire up document store and vector collection on startup"
```

---

## Task 7: routes/chat.ts — inject document chunks

**Files:**
- Modify: `packages/server/src/routes/chat.ts`

- [ ] **Step 1: Add docIds to StreamBody and import searchChunks**

At the top of `packages/server/src/routes/chat.ts`, add import:

```typescript
import { searchChunks, isDocVectorAvailable } from '../services/documentVector.js'
import type { DocumentChunk } from '../types.js'
```

Change `StreamBody` interface:

```typescript
interface StreamBody {
  message: string
  history?: LLMMessage[]
  systemPrompt?: string
  docIds?: string[]
}
```

- [ ] **Step 2: Add getRelevantChunks function**

Add after the existing `getRelevantNotes` function:

```typescript
async function getRelevantChunks(query: string, docIds: string[]): Promise<DocumentChunk[]> {
  if (!docIds.length || !isDocVectorAvailable()) return []
  return searchChunks(query, docIds, 3)
}
```

- [ ] **Step 3: Update the stream handler to use docIds**

In the `/chat/stream` handler, change:

```typescript
// Change:
const { message, history = [], systemPrompt } = request.body

// To:
const { message, history = [], systemPrompt, docIds = [] } = request.body
```

Change the parallel fetch:

```typescript
// Change:
const [relevantNotes, toolSection] = await Promise.all([
  getRelevantNotes(message),
  runToolsIfNeeded(message, history),
])

// To:
const [relevantNotes, relevantChunks, toolSection] = await Promise.all([
  getRelevantNotes(message),
  getRelevantChunks(message, docIds),
  runToolsIfNeeded(message, history),
])
```

Add docSection after memSection:

```typescript
// Add after memSection:
const docSection = relevantChunks.length
  ? `--- 文档参考 ---\n${relevantChunks.map(c => `[${c.filename} · 块${c.chunk_index}] ${c.content}`).join('\n')}`
  : ''

// Change finalSystem to include docSection:
const finalSystem = [systemPrompt ?? DEFAULT_SYSTEM, memSection, docSection, toolSection]
  .filter(Boolean)
  .join('\n\n')
```

- [ ] **Step 4: Test with uploaded document**

First get a doc ID from the list, then test:

```bash
DOC_ID=$(curl -s http://localhost:3001/api/documents | python3 -c "import sys,json; docs=json.load(sys.stdin)['documents']; print(docs[0]['id'] if docs else '')")

curl -s -N -X POST http://localhost:3001/api/chat/stream \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"这份文档主要讲什么\", \"docIds\": [\"$DOC_ID\"]}" \
  | grep -oP '(?<="text":")[^"]+' | tr -d '\n'
echo ""
```

Expected: AI response references content from the uploaded PDF.

- [ ] **Step 5: Typecheck**

```bash
cd packages/server && pnpm exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/chat.ts
git commit -m "feat(server): inject document chunks into chat system prompt"
```

---

## Task 8: useDocuments.ts — frontend hook

**Files:**
- Create: `packages/client/src/hooks/useDocuments.ts`

- [ ] **Step 1: Create the hook**

```typescript
// packages/client/src/hooks/useDocuments.ts
import { useState, useEffect, useCallback } from 'react'
import type { Document } from '../types'

const API = 'http://localhost:3001/api'
const MAX_FILE_BYTES = 10 * 1024 * 1024

export interface UseDocumentsReturn {
  documents: Document[]
  attachedIds: string[]
  uploading: boolean
  uploadError: string | null
  attach: (docId: string) => void
  detach: (docId: string) => void
  upload: (file: File) => Promise<void>
  remove: (docId: string) => Promise<void>
  clearError: () => void
}

export function useDocuments(): UseDocumentsReturn {
  const [documents, setDocuments] = useState<Document[]>([])
  const [attachedIds, setAttachedIds] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/documents`)
      .then(r => r.json())
      .then((data: { documents: Document[] }) => setDocuments(data.documents))
      .catch(() => {})
  }, [])

  const attach = useCallback((docId: string) => {
    setAttachedIds(prev => prev.includes(docId) ? prev : [...prev, docId])
  }, [])

  const detach = useCallback((docId: string) => {
    setAttachedIds(prev => prev.filter(id => id !== docId))
  }, [])

  const upload = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setUploadError('文件超过 10MB 限制')
      return
    }
    if (file.type !== 'application/pdf') {
      setUploadError('只支持 PDF 文件')
      return
    }

    setUploading(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${API}/documents`, { method: 'POST', body: form })
      const data = await res.json() as { document?: Document; error?: string }
      if (!res.ok) {
        setUploadError(data.error ?? '上传失败')
        return
      }
      if (data.document) {
        setDocuments(prev => [data.document!, ...prev])
        attach(data.document.id)
      }
    } catch {
      setUploadError('网络错误，上传失败')
    } finally {
      setUploading(false)
    }
  }, [attach])

  const remove = useCallback(async (docId: string) => {
    await fetch(`${API}/documents/${docId}`, { method: 'DELETE' })
    setDocuments(prev => prev.filter(d => d.id !== docId))
    setAttachedIds(prev => prev.filter(id => id !== docId))
  }, [])

  const clearError = useCallback(() => setUploadError(null), [])

  return { documents, attachedIds, uploading, uploadError, attach, detach, upload, remove, clearError }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/client && pnpm exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks/useDocuments.ts
git commit -m "feat(client): add useDocuments hook for document state management"
```

---

## Task 9: DocumentChip component

**Files:**
- Create: `packages/client/src/components/DocumentChip.tsx`
- Create: `packages/client/src/components/DocumentChip.module.css`

- [ ] **Step 1: Create the component**

```tsx
// packages/client/src/components/DocumentChip.tsx
import styles from './DocumentChip.module.css'

interface DocumentChipProps {
  filename: string
  onRemove: () => void
}

export function DocumentChip({ filename, onRemove }: DocumentChipProps) {
  const short = filename.length > 20 ? filename.slice(0, 18) + '…' : filename
  return (
    <span className={styles.chip}>
      <span className={styles.icon}>📄</span>
      <span className={styles.name} title={filename}>{short}</span>
      <button className={styles.remove} onClick={onRemove} aria-label={`移除 ${filename}`}>×</button>
    </span>
  )
}
```

- [ ] **Step 2: Create the CSS**

```css
/* packages/client/src/components/DocumentChip.module.css */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: #e8f4fd;
  border: 1px solid #b3d9f5;
  border-radius: 12px;
  font-size: 12px;
  color: #1a6fa8;
  max-width: 180px;
}

.icon {
  font-size: 11px;
  flex-shrink: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: #1a6fa8;
  padding: 0;
  flex-shrink: 0;
  opacity: 0.7;
}

.remove:hover {
  opacity: 1;
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/client && pnpm exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/DocumentChip.tsx packages/client/src/components/DocumentChip.module.css
git commit -m "feat(client): add DocumentChip component"
```

---

## Task 10: DocumentPicker component

**Files:**
- Create: `packages/client/src/components/DocumentPicker.tsx`
- Create: `packages/client/src/components/DocumentPicker.module.css`

- [ ] **Step 1: Create the component**

```tsx
// packages/client/src/components/DocumentPicker.tsx
import { useRef } from 'react'
import type { Document } from '../types'
import styles from './DocumentPicker.module.css'

interface DocumentPickerProps {
  documents: Document[]
  attachedIds: string[]
  uploading: boolean
  uploadError: string | null
  onAttach: (docId: string) => void
  onDetach: (docId: string) => void
  onUpload: (file: File) => void
  onRemove: (docId: string) => void
  onClose: () => void
}

export function DocumentPicker({
  documents, attachedIds, uploading, uploadError,
  onAttach, onDetach, onUpload, onRemove, onClose,
}: DocumentPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onUpload(file)
    e.target.value = ''
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.popover} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span>文档</span>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>

        {uploadError && (
          <div className={styles.error}>{uploadError}</div>
        )}

        <button
          className={styles.uploadBtn}
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? '上传中…' : '+ 上传 PDF'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {documents.length === 0 && !uploading && (
          <p className={styles.empty}>暂无文档，上传 PDF 开始使用</p>
        )}

        <ul className={styles.list}>
          {documents.map(doc => {
            const attached = attachedIds.includes(doc.id)
            return (
              <li key={doc.id} className={styles.item}>
                <label className={styles.label}>
                  <input
                    type="checkbox"
                    checked={attached}
                    onChange={() => attached ? onDetach(doc.id) : onAttach(doc.id)}
                  />
                  <span className={styles.filename} title={doc.filename}>{doc.filename}</span>
                  <span className={styles.meta}>{doc.chunk_count} 块</span>
                </label>
                <button
                  className={styles.deleteBtn}
                  onClick={() => onRemove(doc.id)}
                  title="删除文档"
                >
                  🗑
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create the CSS**

```css
/* packages/client/src/components/DocumentPicker.module.css */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
}

.popover {
  position: absolute;
  bottom: 80px;
  left: 16px;
  width: 300px;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  padding: 12px;
  z-index: 101;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 10px;
}

.close {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: #666;
  line-height: 1;
}

.error {
  background: #fff0f0;
  border: 1px solid #fcc;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  color: #c00;
  margin-bottom: 8px;
}

.uploadBtn {
  width: 100%;
  padding: 7px;
  background: #1a6fa8;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  margin-bottom: 10px;
}

.uploadBtn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.empty {
  font-size: 12px;
  color: #999;
  text-align: center;
  padding: 8px 0;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 240px;
  overflow-y: auto;
}

.item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f0;
}

.item:last-child {
  border-bottom: none;
}

.label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  cursor: pointer;
  min-width: 0;
}

.filename {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 11px;
  color: #999;
  flex-shrink: 0;
}

.deleteBtn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px;
  opacity: 0.5;
  flex-shrink: 0;
}

.deleteBtn:hover {
  opacity: 1;
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/client && pnpm exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/DocumentPicker.tsx packages/client/src/components/DocumentPicker.module.css
git commit -m "feat(client): add DocumentPicker popover component"
```

---

## Task 11: Modify ChatInput — add paperclip + chips

**Files:**
- Modify: `packages/client/src/components/ChatInput.tsx`
- Modify: `packages/client/src/components/ChatInput.module.css`

- [ ] **Step 1: Update ChatInput.tsx**

Replace the entire file:

```tsx
// packages/client/src/components/ChatInput.tsx
import { useState } from 'react'
import type { Document } from '../types'
import { DocumentChip } from './DocumentChip'
import { DocumentPicker } from './DocumentPicker'
import styles from './ChatInput.module.css'

interface ChatInputProps {
  onSend: (message: string, docIds: string[]) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  documents: Document[]
  attachedIds: string[]
  uploading: boolean
  uploadError: string | null
  onAttach: (docId: string) => void
  onDetach: (docId: string) => void
  onUpload: (file: File) => void
  onRemoveDoc: (docId: string) => void
}

export function ChatInput({
  onSend, onStop, streaming, disabled,
  documents, attachedIds, uploading, uploadError,
  onAttach, onDetach, onUpload, onRemoveDoc,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  const handleSend = (): void => {
    if (!value.trim() || streaming) return
    onSend(value.trim(), attachedIds)
    setValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={styles.container}>
      {attachedIds.length > 0 && (
        <div className={styles.chips}>
          {attachedIds.map(id => {
            const doc = documents.find(d => d.id === id)
            if (!doc) return null
            return (
              <DocumentChip
                key={id}
                filename={doc.filename}
                onRemove={() => onDetach(id)}
              />
            )
          })}
        </div>
      )}

      <div className={styles.inputRow}>
        <button
          className={styles.paperclip}
          onClick={() => setPickerOpen(p => !p)}
          title="附加文档"
          type="button"
        >
          📎
        </button>

        <textarea
          className={styles.textarea}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行..."
          rows={1}
          disabled={disabled}
        />

        {streaming ? (
          <button className={`${styles.btn} ${styles.stop}`} onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            className={`${styles.btn} ${styles.send}`}
            onClick={handleSend}
            disabled={!value.trim() || disabled}
          >
            发送
          </button>
        )}
      </div>

      <p className={styles.hint}>Enter 发送 · Shift+Enter 换行</p>

      {pickerOpen && (
        <DocumentPicker
          documents={documents}
          attachedIds={attachedIds}
          uploading={uploading}
          uploadError={uploadError}
          onAttach={onAttach}
          onDetach={onDetach}
          onUpload={file => { onUpload(file); setPickerOpen(false) }}
          onRemove={onRemoveDoc}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add new CSS rules to ChatInput.module.css**

Open `packages/client/src/components/ChatInput.module.css` and append:

```css
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 4px;
}

.paperclip {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1;
  flex-shrink: 0;
  opacity: 0.7;
}

.paperclip:hover {
  opacity: 1;
  background: #f0f0f0;
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/client && pnpm exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/ChatInput.tsx packages/client/src/components/ChatInput.module.css
git commit -m "feat(client): add paperclip icon and document chips to ChatInput"
```

---

## Task 12: Wire up in App.tsx and useChat.ts

**Files:**
- Modify: `packages/client/src/App.tsx`
- Modify: `packages/client/src/hooks/useChat.ts`

- [ ] **Step 1: Update useChat to accept docIds in sendMessage**

Open `packages/client/src/hooks/useChat.ts`. Update the `sendMessage` signature and the fetch call.

Find `sendMessage` function (where it calls `POST /api/chat/stream`) and:

1. Change `sendMessage: (message: string, systemPrompt?: string) => Promise<void>` to accept `docIds`:

In the function definition, change:
```typescript
// Find:
sendMessage: async (message: string, systemPrompt?: string): Promise<void> => {

// Change to:
sendMessage: async (message: string, systemPrompt?: string, docIds: string[] = []): Promise<void> => {
```

2. In the fetch body, add `docIds`:
```typescript
// Find the fetch body (JSON.stringify call) and add docIds:
body: JSON.stringify({
  message,
  history: trimmed,
  systemPrompt,
  docIds,
}),
```

3. Update `UseChatReturn` type in `packages/client/src/types.ts`:
```typescript
// Change:
sendMessage: (message: string, systemPrompt?: string) => Promise<void>
// To:
sendMessage: (message: string, systemPrompt?: string, docIds?: string[]) => Promise<void>
```

- [ ] **Step 2: Update App.tsx to use useDocuments and pass props to ChatInput**

Open `packages/client/src/App.tsx`. Add import and hook:

```typescript
import { useDocuments } from './hooks/useDocuments'
```

Inside the component, add after `useChat()`:
```typescript
const docs = useDocuments()
```

Update the `<ChatInput>` JSX to pass document props:
```tsx
<ChatInput
  onSend={(msg, docIds) => chat.sendMessage(msg, undefined, docIds)}
  onStop={chat.stopStreaming}
  streaming={chat.streaming}
  documents={docs.documents}
  attachedIds={docs.attachedIds}
  uploading={docs.uploading}
  uploadError={docs.uploadError}
  onAttach={docs.attach}
  onDetach={docs.detach}
  onUpload={docs.upload}
  onRemoveDoc={docs.remove}
/>
```

- [ ] **Step 3: Typecheck both packages**

```bash
cd packages/server && pnpm exec tsc --noEmit
cd packages/client && pnpm exec tsc --noEmit
```

Expected: no errors in either package.

- [ ] **Step 4: Full end-to-end test in browser**

1. Open http://localhost:5174
2. Click 📎 paperclip icon → DocumentPicker appears
3. Upload a PDF → chip appears above input
4. Ask a question about the PDF content
5. Verify AI response references document content

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/App.tsx packages/client/src/hooks/useChat.ts packages/client/src/types.ts
git commit -m "feat(client): wire up document picker in App and useChat"
```

---

## Final: Create PR

```bash
git push -u origin HEAD
gh pr create --title "feat: PDF document RAG — upload, chunk, embed, retrieve" \
  --body "Implements Milestone 2 document upload flow: pdf-parse + custom chunker + Zhipu embedding-3 + ChromaDB docmind_docs collection. Users attach PDFs via paperclip icon; top-3 relevant chunks injected into system prompt per query."
```
