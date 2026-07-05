# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DocMind is a RAG (Retrieval-Augmented Generation) document Q&A application. Users upload documents (PDF/TXT) and ask questions via a streaming chat interface. The LLM backend supports Anthropic Claude and Zhipu AI (GLM) interchangeably. The app includes a persistent memory system (SQLite + ChromaDB) and real-time tool calling (weather).

## Commands

```bash
# Install dependencies (pnpm workspaces)
pnpm install

# Development (run in separate terminals)
pnpm run dev:server    # tsx watch — Fastify backend on http://localhost:3001
pnpm run dev:client    # Vite dev server on http://localhost:5173

# Production build
pnpm run build:client  # Vite build for client

# Type checking (no compile step needed — tsx handles runtime)
cd packages/server && pnpm exec tsc --noEmit
cd packages/client && pnpm exec tsc --noEmit

# Docker (dev: docker-compose.dev.yml; prod deploy: docker-compose.prod.yml)
docker compose -f docker-compose.dev.yml up chroma -d   # Start only ChromaDB (required for dev)
docker compose -f docker-compose.dev.yml up --build     # Full stack (Chroma + Server + Client)
```

There is no lint or test script configured yet.

## Environment Setup

Copy and configure the server env file before starting:

```bash
cp packages/server/.env.example packages/server/.env
```

Key variables in `packages/server/.env`:
- `ANTHROPIC_API_KEY` — enables Anthropic provider (auto-detected)
- `ZHIPU_API_KEY` — enables Zhipu provider (OpenAI-compatible API); also used for embeddings
- `PORT` — default `3001`
- `CHROMA_URL` — default `http://localhost:8000`
- `ANTHROPIC_MODEL` / `ZHIPU_MODEL` — optional model overrides (default: `glm-4.7` for tool calling support)
- `ZHIPU_EMBEDDING_MODEL` — optional override (default: `embedding-3`)
- `DISABLE_EMBEDDING` — set to `true` to skip vector embeddings (falls back to FTS5 search)

Provider is auto-detected: if `ANTHROPIC_API_KEY` is set it uses Anthropic; otherwise falls back to Zhipu.

> **Note**: Tool calling (weather etc.) requires GLM-4.7 or above. `glm-4-flash` does not support function calling.

## Architecture

### Monorepo Layout

```
packages/
  server/   (@docmind/server) — Fastify + TypeScript backend (tsx runtime)
  client/   (@docmind/client) — React 19 + Vite + TypeScript frontend
```

Managed with pnpm workspaces (`pnpm-workspace.yaml`). Root `package.json` has convenience `dev:*` and `build:*` scripts that delegate to each package.

### Backend (`packages/server/src/`)

- **`index.ts`** — Fastify entry point; registers CORS, multipart, and route plugins; calls `initDb()` on startup
- **`llm.ts`** — Provider abstraction: exports `streamChat(options)` which dispatches to `streamAnthropic` or `streamZhipu`. Both return async generators yielding text chunks. Has quota-error detection (`isQuotaError`) to skip retries.
- **`types.ts`** — Shared TypeScript types: `LLMProvider`, `LLMMessage`, `StreamChatOptions`, `MemoryNote`, `ParsedCompact`
- **`routes/chat.ts`** — Chat endpoints. `POST /api/chat/stream` runs tool pre-flight + memory retrieval in parallel, then streams response. `POST /api/chat/compact` summarizes history and extracts facts. `POST /api/chat/nudge` silently extracts facts from recent messages.
- **`routes/documents.ts`** — Document upload/list/delete: `POST/GET/DELETE /api/documents`. Parses PDF, chunks, embeds, stores in ChromaDB (fire-and-forget upsert).
- **`routes/memory.ts`** — CRUD for memory notes: `GET /api/memory`, `POST /api/memory`, `DELETE /api/memory/:id`, `DELETE /api/memory`.
- **`routes/eval.ts`** — RAG evaluation API: generate test sets, run/resume evaluations, list runs, fetch run detail (with question/answer/scores).
- **`services/memoryStore.ts`** — SQLite-backed memory store via `better-sqlite3`. FTS5 full-text search. Max 100 notes, 200 chars each. Auto-evicts oldest when over limit. Exports `DB` type shared by other stores.
- **`services/memoryVector.ts`** — ChromaDB integration for semantic (vector) search. Falls back gracefully if ChromaDB is unavailable.
- **`services/documentStore.ts`** — SQLite `documents` table (id, filename, size, chunk_count). Shares the memory DB connection.
- **`services/chatStore.ts`** — SQLite `conversations` table (per-user multiple independent conversations: id, user_id, title, created_at, updated_at, monotonic updated_seq) + `chat_messages` table with `conversation_id` column. `seq` and `hasGenerating` are now per-conversation. Server-side source of truth for chat history. On startup flips any lingering `generating` rows to `error` (crash recovery) and backfills legacy messages into one conversation per user. Shares the memory DB connection.
- **`services/chatGeneration.ts`** — `streamAndPersist`: consumes the LLM stream to completion even if the client disconnects (send() failures are swallowed), persisting the full answer via `updateMessageContent`. This is what lets a refreshed-away answer still finish and be recovered.
- **`services/documentVector.ts`** — ChromaDB `docmind_docs` collection. `upsertChunks`, `searchChunks` (filter by doc_id), `getAllChunksByDoc`. `ZhipuEmbeddingFunction` attached.
- **`services/pdfParser.ts`** — `pdf-parse` (CJS via `createRequire`) + recursive character splitter (500-char chunks, 50 overlap).
- **`services/embeddings.ts`** — Zhipu `embedding-3` API via native `fetch` (OpenAI SDK returned zero vectors for Zhipu). `embedBatch` chunks input into ≤64 (Zhipu API limit). Exports `ZhipuEmbeddingFunction`.
- **`services/evalStore.ts`** — SQLite eval tables: `eval_test_sets`, `eval_cases`, `eval_runs`, `eval_results`. Idempotent ALTER-TABLE migrations.
- **`services/evalGenerator.ts`** — LLM auto-generates 2-3 Q&A pairs per chunk into a test set.
- **`services/evalJudge.ts`** — LLM-as-Judge: rule-based context recall + merged single-call scoring (precision/faithfulness/relevancy) with token usage capture.
- **`services/evalRunner.ts`** — Orchestrates a run (search → answer → score → persist); `resumeEvaluation` re-runs only failed/missing cases.
- **`services/llmThrottle.ts`** — Adaptive slow-start throttle (12s → shrink on success, ×2 on 429, 90s call timeout) shared by all eval LLM calls.
- **`tools/weather.ts`** — Fetches real-time weather from `wttr.in` (free, no API key). Returns formatted Chinese string.

### Frontend (`packages/client/src/`)

- **`hooks/useChat.ts`** — Central state hook: takes `(userId, conversationId, onConversationCreated)` and loads history per-conversation from the server (`GET /api/chat/messages?conversationId=`, server is the source of truth — no localStorage). Optimistically appends the outgoing turn, reads the SSE stream via `fetch` + `ReadableStream`. On mount, if the last message is still `generating`, polls the server (~1s, ≤2min cap) to recover an answer that finished after a refresh. Lazily creates a new conversation on first send if none exists. Aborts the client reader on conversation switch (server continues generating). Triggers auto-compression when token count exceeds 12000, handles pinning (PATCH). Uses a `runId` token + `mountedRef` (StrictMode-safe) to prevent stale polls from overwriting a newer state.
- **`hooks/useConversations.ts`** — Conversation management hook: lists conversations, tracks the selected conversation, creates/deletes conversations, and polls (~2s, only while some conversation is generating) to refresh the generating-in-progress dot. Exposes `conversations` list, `currentId` (`null` = empty draft), `loading`, and callbacks `selectConversation`/`newConversation`/`deleteConversation`/`onConversationCreated`/`refresh`. Persists the selected id in `localStorage['docmind:currentConv:<userId>']`.
- **`components/ConversationList.tsx`** — Sidebar conversation list: displays all conversations with titles, updated timestamp, and generating indicator dot. Supports creating new conversation and switching between conversations.
- **`App.tsx`** — Top-level layout: sidebar (ConversationList + MemoryPanel) + chat area.
- **`components/Message.tsx`** — Renders user and assistant messages; assistant messages use `react-markdown`; supports pin button and summary-collapse bar.
- **`components/ChatInput.tsx`** — Textarea input (Enter sends, Shift+Enter newlines); shows Stop button during streaming.
- **`components/MemoryPanel.tsx`** — Sidebar panel showing stored memory notes; supports manual add and delete.
- **`types.ts`** — Shared types: `MessageRole`, `ChatMessage`, `MemoryNote`, `MemoryStore`, `UseChatReturn`

### TypeScript Configuration

**Backend** (`packages/server/tsconfig.json`):
- `moduleResolution: "NodeNext"`, `module: "NodeNext"` — ESM with explicit `.js` extensions in imports
- `target: "ES2022"`, `strict: true`
- No compile step — `tsx` handles runtime transpilation directly

**Frontend** (`packages/client/tsconfig.json`):
- `moduleResolution: "bundler"` — Vite handles resolution; no `.js` extensions needed
- `jsx: "react-jsx"`, `strict: true`, `noEmit: true`, `allowImportingTsExtensions: true`

### Data Flow

```
ChatInput → useChat.sendMessage()
  → POST /api/chat/stream (body: {message, history[], systemPrompt})
  → parallel: getRelevantNotes(message) + runToolsIfNeeded(message, history)
  → build finalSystem = [systemPrompt, memSection, toolSection].join('\n\n')
  → server trims history → llm.streamChat()
  → SSE chunks → useChat.appendToLast()
  → Message.tsx renders markdown
```

### Memory System

Memory notes are stored in SQLite (`data/memory.db`) and indexed in ChromaDB for semantic search.

**Write path** (three sources):
1. **Manual** — user adds via MemoryPanel UI → `POST /api/memory`
2. **Compact** — user triggers history compression → AI extracts facts → saved with `source: 'compact'`
3. **Nudge** — called automatically every N messages → AI silently extracts facts → saved with `source: 'nudge'`

**Read path** (every chat message):
1. Try semantic search via ChromaDB (if embedding available)
2. Fall back to FTS5 full-text search (SQLite)
3. Top-3 results injected into system prompt as `--- 相关记忆 ---`

**FTS5 limitation**: Chinese text is tokenized by whitespace only, so phrase search across unseparated characters fails. Semantic search via embeddings handles this correctly.

### Tool Calling (Weather)

Two-phase approach for Zhipu provider only:

1. **Pre-flight** (non-streaming): Send message + history to GLM-4.7 with `tools` array and `tool_choice: 'auto'`
2. **Execute**: If model returns `tool_calls`, run the relevant tool (e.g., `getWeather(city)`)
3. **Inject**: Tool result appended to system prompt as `--- 实时工具结果 ---`
4. **Stream**: Main streaming call proceeds with enriched system prompt

Tools defined in `TOOLS` array (OpenAI function calling format). Currently: `get_weather`.

### Key Design Decisions

- **Token estimation**: `Math.ceil(text.length / 3)` (character-based approximation)
- **History compression**: When accumulated tokens > 12000, `useChat` calls `POST /api/chat/compact` to summarize old messages; pinned messages are never compressed or trimmed.
- **Auto-pin keywords**: Messages containing `记住这个`, `重要`, `remember this`, `important` are auto-pinned.
- **Server-side chat persistence**: Chat history lives in SQLite (`chat_messages`), not localStorage. Generation is decoupled from the browser connection — the server finishes and persists the answer even if the client refreshes/disconnects; on reload the client fetches from the server and polls if the last turn is still `generating` (ChatGPT-style recovery). See `docs/superpowers/specs/2026-07-05-server-side-chat-persistence-design.md`.
- **Multi-conversation**: Each user can maintain multiple independent conversations, stored in SQLite `conversations` table with per-conversation message sequence and generation tracking. Server supports concurrent generation across conversations keyed by `conversationId`. Client uses single-path SSE stream + graceful reader abort on conversation switch; server continues generating and client recovers via polling. Quotas and memory/documents remain user-global (not per-conversation). See `docs/superpowers/specs/2026-07-05-multi-conversation-design.md`.
- **CSS Modules**: All component styles are scoped (`*.module.css`).
- **ES Modules only**: No CommonJS — all files use `import`/`export`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Provider status |
| GET | `/api/chat/conversations` | List the user's conversations |
| POST | `/api/chat/conversations` | Create a new empty conversation |
| DELETE | `/api/chat/conversations/:id` | Delete a conversation (cascade messages; abort generation if in progress) |
| POST | `/api/chat/stream` | SSE streaming chat (body carries `conversationId`; persists user + assistant msgs; keeps generating after client disconnect) |
| POST | `/api/chat/stop` | Abort in-flight generation for a conversation |
| GET | `/api/chat/messages` | Load messages for a conversation (query param: `?conversationId=` required; source of truth for the client) |
| PATCH | `/api/chat/messages/:id` | Toggle a message's pinned flag |
| POST | `/api/chat/compact` | Summarize messages (by id) + replace them with a summary row + extract facts (body carries `conversationId`) |
| POST | `/api/chat/nudge` | Silently extract facts from recent messages |
| GET | `/api/memory` | List all memory notes |
| POST | `/api/memory` | Add a memory note |
| DELETE | `/api/memory/:id` | Delete one note |
| DELETE | `/api/memory` | Clear all notes |
| GET | `/api/documents` | List uploaded documents |
| POST | `/api/documents` | Upload a PDF (multipart) — parse, chunk, embed |
| DELETE | `/api/documents/:id` | Delete a document + its chunks |
| POST | `/api/eval/generate` | Auto-generate a test set for a document |
| GET | `/api/eval/test-sets` | List test sets / `/:id` for cases |
| DELETE | `/api/eval/test-sets/:id` | Delete a test set (cascade) |
| POST | `/api/eval/runs` | Run an evaluation (blocking) |
| POST | `/api/eval/runs/:id/resume` | Resume a failed/interrupted run |
| GET | `/api/eval/runs` | List runs / `/:id` for results |

### Infrastructure

- **ChromaDB**: Local vector store for memory embeddings (port 8000, `chroma_data` Docker volume)
- **SQLite**: Local relational store for memory notes (`data/memory.db`, auto-created on startup)
- **wttr.in**: Free weather API, no key needed, 8-second timeout
- **Docker Compose**: Three services — `chroma`, `server`, `client` (nginx multi-stage build)
- **CI**: GitHub Actions on push/PR to `main` — installs deps, builds client, syntax-checks server

## Current Status

- **Milestone 1 complete**: SSE streaming, history management, compression, pinning, dual LLM, localStorage
- **Milestone 1.5 complete**: Full TypeScript migration (frontend + backend), memory system (SQLite + ChromaDB + embeddings), tool calling (weather via wttr.in)
- **Milestone 2 complete**: PDF upload + parsing, recursive chunking, ChromaDB document embedding/retrieval, per-message document attachment UI (📎 picker), RAG injection into system prompt
- **Milestone 3 complete**: RAG automated evaluation system — LLM auto-generated test sets, merged LLM-as-Judge (recall/precision/faithfulness/relevancy), adaptive throttle + resumable runs + token tracking, EvalPanel UI. Baseline on 184-case set: Recall 88.0% / Precision 73.7% / Faithfulness 90.5% / Relevancy 89.5% (see `docs/superpowers/specs/2026-05-16-rag-evaluation-report.md`)
- **Next**: precision is the bottleneck (~1/4 retrieved chunks are noise) — roadmap is rerank + section-based chunking
