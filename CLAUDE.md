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

# Docker
docker compose up chroma -d          # Start only ChromaDB (required for dev)
docker compose up --build            # Full stack (Chroma + Server + Client)
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
- **`routes/documents.ts`** — Placeholder for Milestone 2 document upload/retrieval.
- **`routes/memory.ts`** — CRUD for memory notes: `GET /api/memory`, `POST /api/memory`, `DELETE /api/memory/:id`, `DELETE /api/memory`.
- **`services/memoryStore.ts`** — SQLite-backed memory store via `better-sqlite3`. FTS5 full-text search. Max 100 notes, 200 chars each. Auto-evicts oldest when over limit.
- **`services/memoryVector.ts`** — ChromaDB integration for semantic (vector) search. Falls back gracefully if ChromaDB is unavailable.
- **`services/embeddings.ts`** — Zhipu `embedding-3` API wrapper. `isEmbeddingAvailable()` checks for API key and `DISABLE_EMBEDDING` flag.
- **`tools/weather.ts`** — Fetches real-time weather from `wttr.in` (free, no API key). Returns formatted Chinese string.

### Frontend (`packages/client/src/`)

- **`hooks/useChat.ts`** — Central state hook: sends messages, reads SSE stream via `fetch` + `ReadableStream`, manages message history in state + localStorage (50-message cap), triggers auto-compression when token count exceeds 12000, handles pinning.
- **`App.tsx`** — Top-level layout: sidebar + chat area.
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
- **localStorage persistence**: Saved 500ms after streaming ends (debounced).
- **CSS Modules**: All component styles are scoped (`*.module.css`).
- **ES Modules only**: No CommonJS — all files use `import`/`export`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Provider status |
| POST | `/api/chat/stream` | SSE streaming chat (with tool calling + memory) |
| POST | `/api/chat/compact` | Summarize history + extract facts |
| POST | `/api/chat/nudge` | Silently extract facts from recent messages |
| GET | `/api/memory` | List all memory notes |
| POST | `/api/memory` | Add a memory note |
| DELETE | `/api/memory/:id` | Delete one note |
| DELETE | `/api/memory` | Clear all notes |
| GET | `/api/documents` | Document list (M2, placeholder) |

### Infrastructure

- **ChromaDB**: Local vector store for memory embeddings (port 8000, `chroma_data` Docker volume)
- **SQLite**: Local relational store for memory notes (`data/memory.db`, auto-created on startup)
- **wttr.in**: Free weather API, no key needed, 8-second timeout
- **Docker Compose**: Three services — `chroma`, `server`, `client` (nginx multi-stage build)
- **CI**: GitHub Actions on push/PR to `main` — installs deps, builds client, syntax-checks server

## Current Status

- **Milestone 1 complete**: SSE streaming, history management, compression, pinning, dual LLM, localStorage
- **Milestone 1.5 complete**: Full TypeScript migration (frontend + backend), memory system (SQLite + ChromaDB + embeddings), tool calling (weather via wttr.in)
- **Milestone 2 pending**: Document upload (PDF/TXT parsing), ChromaDB document embedding/retrieval, semantic search over docs, citation UI, document management
