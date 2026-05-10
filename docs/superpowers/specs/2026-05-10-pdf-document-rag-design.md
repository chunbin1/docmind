# PDF Document RAG — Design Spec

**Goal:** Users can upload PDF files, attach them to a conversation, and ask questions about the content. Answers are grounded in retrieved document chunks via semantic search.

**Approach:** pdf-parse for extraction, custom chunking, Zhipu embedding-3 for vectors, ChromaDB `docmind_docs` collection for retrieval, SQLite for metadata and conversation-document bindings.

---

## Architecture

### New Backend Files

| File | Responsibility |
|------|---------------|
| `services/documentStore.ts` | SQLite: documents table + conversation_documents join table |
| `services/documentVector.ts` | ChromaDB: upsert chunks, semantic search filtered by doc_ids |
| `services/pdfParser.ts` | pdf-parse wrapper + recursive character chunker |
| `routes/documents.ts` | Replace placeholder — upload, list, delete endpoints |

### Modified Backend Files

| File | Change |
|------|--------|
| `routes/chat.ts` | Inject document chunks into system prompt alongside memory notes |
| `types.ts` | Add `Document`, `DocumentChunk` types |

### New Frontend Files

| File | Responsibility |
|------|---------------|
| `hooks/useDocuments.ts` | Fetch document list, attach/detach per conversation, upload |
| `components/DocumentPicker.tsx` | Popover: list existing docs + upload new PDF |
| `components/DocumentChip.tsx` | Small removable tag shown above input for attached docs |

### Modified Frontend Files

| File | Change |
|------|--------|
| `ChatInput.tsx` | Add paperclip icon, render chips above textarea, wire DocumentPicker |
| `types.ts` | Add `Document` type |

---

## Data Model

### SQLite — `documents` table

```sql
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
```

### SQLite — `conversation_documents` table

```sql
CREATE TABLE conversation_documents (
  conversation_id TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  PRIMARY KEY (conversation_id, doc_id)
);
```

`conversation_id` is a client-generated UUID stored in localStorage alongside chat history.

### ChromaDB — `docmind_docs` collection

Each chunk stored with metadata:
```json
{ "doc_id": "doc_abc123", "filename": "contract.pdf", "chunk_index": 3 }
```

---

## Data Flow

### Upload

```
POST /api/documents (multipart, PDF file)
  → validate: size ≤ 10MB, mime = application/pdf
  → pdfParser.parse(buffer) → raw text
  → pdfParser.chunk(text, { chunkSize: 500, overlap: 50 }) → string[]
  → embed each chunk via embeddings.embedBatch()
  → documentVector.upsertChunks(docId, chunks, embeddings)
  → documentStore.saveDocument({ id, filename, size, chunkCount })
  → return { id, filename, chunkCount }
```

### Chat (modified `/api/chat/stream`)

```
existing: getRelevantNotes(message) → memSection
new:      getRelevantChunks(message, docIds) → docSection

finalSystem = [DEFAULT_SYSTEM, memSection, docSection, toolSection]
  .filter(Boolean).join('\n\n')
```

`docIds` comes from the request body — client sends the list of attached doc IDs with each chat message.

### Delete

```
DELETE /api/documents/:id
  → documentVector.deleteByDocId(id)   ← remove all chunks from ChromaDB
  → documentStore.deleteDocument(id)   ← remove from SQLite + cascade conversation_documents
```

---

## Chunking Strategy

Recursive character splitter, same logic as LangChain's `RecursiveCharacterTextSplitter`:

1. Try to split on `\n\n` (paragraphs)
2. Fall back to `\n` (lines)
3. Fall back to ` ` (words)

Parameters: `chunkSize = 500`, `overlap = 50`. Chunks injected into system prompt are the top-3 by cosine similarity, formatted as:

```
--- 文档参考 ---
[contract.pdf · 块3] 付款条款：买方应在验收合格后30日内...
[contract.pdf · 块7] 违约责任：若逾期付款，应按日计0.05%...
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/documents` | Upload PDF (multipart) |
| GET | `/api/documents` | List all documents |
| DELETE | `/api/documents/:id` | Delete document + all its chunks |

Chat endpoint change: `POST /api/chat/stream` body gains optional `docIds: string[]`.

---

## Frontend Interaction

1. User clicks paperclip icon (left of textarea)
2. `DocumentPicker` popover opens — shows existing docs with checkboxes + "上传 PDF" button
3. Checking a doc → adds to attached list → `DocumentChip` appears above textarea
4. On send, `useChat` includes `docIds` in the request body
5. File size > 10MB → client-side toast error, no upload attempted

---

## Error Handling

| Scenario | Behavior |
|----------|---------|
| PDF encrypted / corrupt | Server returns 400 with message; frontend toast |
| File > 10MB | Client rejects before upload |
| Embedding unavailable (`DISABLE_EMBEDDING=true`) | Skip vectorization; doc saved to SQLite only; retrieval skipped silently |
| ChromaDB unavailable | Same as above — graceful degradation, chat unaffected |
| PDF has no extractable text (scanned image) | Return 422: "该 PDF 为扫描件，暂不支持" |

---

## Out of Scope

- TXT file support (add later, same pipeline minus pdf-parse)
- Page-level citation UI (show exact page number)
- Re-embedding existing docs after model change
- Document preview / viewer
