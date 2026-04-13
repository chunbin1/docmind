# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DocMind is a RAG (Retrieval-Augmented Generation) document Q&A application. Users upload documents (PDF/TXT) and ask questions via a streaming chat interface. The LLM backend supports Anthropic Claude and Zhipu AI (GLM) interchangeably.

## Commands

```bash
# Install dependencies
npm install

# Development (run in separate terminals)
npm run dev:server    # Fastify backend on http://localhost:3001
npm run dev:client    # Vite dev server on http://localhost:5173

# Production build
npm run build:client  # Vite build for client

# Docker
docker compose up chroma -d          # Start only ChromaDB (required for dev)
docker compose up --build            # Full stack (Chroma + Server + Client)

# Syntax check (CI equivalent)
node --check packages/server/src/index.js
```

There is no lint or test script configured yet.

## Environment Setup

Copy and configure the server env file before starting:

```bash
cp packages/server/.env.example packages/server/.env
```

Key variables in `packages/server/.env`:
- `ANTHROPIC_API_KEY` — enables Anthropic provider (auto-detected)
- `ZHIPU_API_KEY` — enables Zhipu provider (OpenAI-compatible API)
- `PORT` — default `3001`
- `CHROMA_URL` — default `http://localhost:8000`
- `ANTHROPIC_MODEL` / `ZHIPU_MODEL` — optional model overrides

Provider is auto-detected: if `ANTHROPIC_API_KEY` is set it uses Anthropic; otherwise falls back to Zhipu.

## Architecture

### Monorepo Layout

```
packages/
  server/   (@docmind/server) — Fastify + LangChain.js backend
  client/   (@docmind/client) — React 19 + Vite frontend
```

Managed with pnpm workspaces (`pnpm-workspace.yaml`). Root `package.json` has convenience `dev:*` and `build:*` scripts that delegate to each package.

### Backend (`packages/server/src/`)

- **`index.js`** — Fastify entry point; registers CORS, multipart, and route plugins; exposes `GET /health`
- **`llm.js`** — Provider abstraction: exports `streamChat(messages, systemPrompt)` which dispatches to `streamAnthropic` or `streamZhipu` based on env config. Both return async generators yielding text chunks.
- **`routes/chat.js`** — `POST /api/chat/stream` (SSE streaming) and `POST /api/chat/compact` (history summarization). Contains `trimHistoryByTokens()` which enforces a 6000-token budget, protecting pinned messages.
- **`routes/documents.js`** — Placeholder for Milestone 2 document upload/retrieval (not yet implemented).

### Frontend (`packages/client/src/`)

- **`useChat.js`** — Central state hook: sends messages, reads SSE stream via `fetch` + `ReadableStream`, manages message history in state + localStorage (50-message cap), triggers auto-compression when token count exceeds 12000, handles pinning.
- **`App.jsx`** — Top-level layout: sidebar + chat area; passes state from `useChat` to child components.
- **`Message.jsx`** — Renders user and assistant messages; assistant messages use `react-markdown`; supports pin button and summary-collapse bar.
- **`ChatInput.jsx`** — Textarea input (Enter sends, Shift+Enter newlines); shows Stop button during streaming.

### Data Flow

```
ChatInput → useChat.sendMessage()
  → POST /api/chat/stream (body: {message, history[], systemPrompt})
  → server trims history → llm.streamChat()
  → SSE chunks → useChat.appendToLast()
  → Message.jsx renders markdown
```

### Key Design Decisions

- **Token estimation**: `Math.ceil(text.length / 3)` (character-based approximation)
- **History compression**: When accumulated tokens > 12000, `useChat` calls `POST /api/chat/compact` to summarize old messages; pinned messages are never compressed or trimmed.
- **Auto-pin keywords**: Messages containing phrases like `记住这个`, `重要`, `remember this`, `important` are auto-pinned.
- **localStorage persistence**: Saved 500ms after streaming ends (debounced).
- **CSS Modules**: All component styles are scoped (`*.module.css`).
- **ES Modules only**: No CommonJS — all files use `import`/`export`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Provider status |
| POST | `/api/chat/stream` | SSE streaming chat |
| POST | `/api/chat/compact` | Summarize message history |
| GET | `/api/documents` | Document list (M2, placeholder) |

### Infrastructure

- **ChromaDB**: Vector store for document embeddings (port 8000, `chroma_data` Docker volume)
- **Docker Compose**: Three services — `chroma`, `server`, `client` (nginx multi-stage build)
- **CI**: GitHub Actions on push/PR to `main` — installs deps, builds client, syntax-checks server

## Current Status

- **Milestone 1 complete**: SSE streaming, history management, compression, pinning, dual LLM, localStorage
- **Milestone 2 pending**: Document upload (PDF/TXT parsing), ChromaDB embedding/retrieval, semantic search, citation UI, document management
