# DocMind — 智能文档问答系统 / Intelligent Document Q&A

[English](#english) | [中文](#chinese)

---

<a name="chinese"></a>
## 中文

基于 RAG（检索增强生成）的文档问答应用，支持上传 PDF/TXT 文档，通过语义检索 + LLM 实现精准问答，并内置持久化记忆系统。

![CI](https://github.com/chunbin1/docmind/actions/workflows/ci.yml/badge.svg)

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite + CSS Modules |
| 后端 | Node.js + Fastify |
| AI | Anthropic Claude / Zhipu AI (GLM)，可互换 |
| 记忆存储 | SQLite (better-sqlite3) + FTS5 全文检索 |
| 向量数据库 | ChromaDB + Zhipu embedding-3 |
| 部署 | Docker Compose + GitHub Actions |

### 功能

- [x] 流式对话（SSE）
- [x] 双 LLM 支持：Anthropic Claude & 智谱 AI，自动检测
- [x] 智谱多模型备用：额度耗尽自动切换下一个模型
- [x] 持久化记忆系统（SQLite）
- [x] 语义记忆检索（ChromaDB + embedding-3）
- [x] 对话摘要自动提取事实（Smart Compact）
- [x] 每 10 轮静默提取关键信息（Nudge）
- [x] 记忆面板 UI（查看 / 搜索 / 增删）
- [x] PDF 文档上传与解析（递归字符分块）
- [x] 文档向量化与 RAG 问答（ChromaDB + 每条消息附加文档）
- [x] RAG 自动化评估系统（LLM 出题 + LLM-as-Judge 四维打分）
- [ ] 引用来源标注
- [ ] 检索精排（Rerank）与按章节分块

### 快速开始

#### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/chunbin1/docmind.git
cd docmind

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp packages/server/.env.example packages/server/.env
# 编辑 .env，填入 ANTHROPIC_API_KEY 或 ZHIPU_API_KEY

# 4. 启动 ChromaDB（可选，用于语义记忆检索，需要 Docker）
docker compose -f docker-compose.dev.yml up chroma -d

# 5. 启动开发服务器（两个终端分别运行）
npm run dev:server   # http://localhost:3001
npm run dev:client   # http://localhost:5173
```

#### Docker 一键启动

```bash
cp packages/server/.env.example packages/server/.env
# 填入 API Key

docker compose -f docker-compose.dev.yml up --build
# 访问 http://localhost:5173
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | Anthropic API Key | — |
| `ANTHROPIC_MODEL` | Claude 模型 | `claude-sonnet-4-5` |
| `ZHIPU_API_KEY` | 智谱 AI API Key | — |
| `ZHIPU_MODEL` | GLM 模型，逗号分隔（自动降级） | `glm-4-flash` |
| `PORT` | 服务端口 | `3001` |
| `CHROMA_URL` | ChromaDB 地址 | `http://localhost:8000` |

### 项目结构

```
docmind/
├── packages/
│   ├── server/src/
│   │   ├── index.js               # Fastify 入口
│   │   ├── llm.js                 # LLM 适配器（Anthropic / Zhipu）
│   │   ├── routes/
│   │   │   ├── chat.js            # 流式对话、摘要、Nudge
│   │   │   └── memory.js          # 记忆 CRUD API
│   │   └── services/
│   │       ├── memoryStore.js     # SQLite + FTS5
│   │       ├── memoryVector.js    # ChromaDB 语义检索
│   │       └── embeddings.js      # Zhipu embedding-3
│   └── client/src/
│       ├── App.jsx
│       ├── hooks/useChat.js       # 流式请求 + Nudge 触发
│       └── components/
│           ├── Message.jsx
│           ├── ChatInput.jsx
│           └── MemoryPanel.jsx    # 记忆管理面板
├── docker-compose.dev.yml   # 本地开发
├── docker-compose.prod.yml  # 远程部署
└── .github/workflows/ci.yml
```

### 记忆系统架构

```
用户发送消息
   ↓
语义检索相关记忆（ChromaDB top-3）← 降级为 FTS5 关键字检索
   ↓
注入 System Prompt
   ↓
LLM 生成回复（具备记忆上下文）
   ↓
每 10 轮 → Nudge 静默提取关键事实 → SQLite + ChromaDB
历史超长 → Smart Compact 摘要 → 提取 facts → SQLite + ChromaDB
```

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 服务状态 |
| POST | `/api/chat/stream` | SSE 流式对话 |
| POST | `/api/chat/compact` | 历史摘要（返回 summary + facts）|
| POST | `/api/chat/nudge` | 静默提取事实 |
| GET | `/api/memory` | 获取所有记忆 |
| POST | `/api/memory/notes` | 新增记忆 |
| POST | `/api/memory/search` | 语义搜索记忆 |
| DELETE | `/api/memory/notes/:id` | 删除单条记忆 |
| DELETE | `/api/memory` | 清空所有记忆 |

---

<a name="english"></a>
## English

A RAG (Retrieval-Augmented Generation) document Q&A application with streaming chat, persistent memory, and dual LLM support.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite + CSS Modules |
| Backend | Node.js + Fastify |
| AI | Anthropic Claude / Zhipu AI (GLM), interchangeable |
| Memory Store | SQLite (better-sqlite3) + FTS5 full-text search |
| Vector DB | ChromaDB + Zhipu embedding-3 |
| Deploy | Docker Compose + GitHub Actions |

### Features

- [x] Streaming chat (SSE)
- [x] Dual LLM support: Anthropic Claude & Zhipu AI, auto-detected
- [x] Zhipu multi-model fallback: auto-switches on quota exhaustion
- [x] Persistent memory system (SQLite)
- [x] Semantic memory retrieval (ChromaDB + embedding-3)
- [x] Auto fact extraction from summaries (Smart Compact)
- [x] Silent fact extraction every 10 turns (Nudge)
- [x] Memory Panel UI (view / search / add / delete)
- [x] PDF document upload and parsing (recursive character chunking)
- [x] Document vectorization and RAG Q&A (ChromaDB + per-message doc attach)
- [x] RAG automated evaluation system (LLM-generated test sets + LLM-as-Judge)
- [ ] Citation source annotation
- [ ] Retrieval rerank & section-based chunking

### Quick Start

#### Local Development

```bash
# 1. Clone the repo
git clone https://github.com/chunbin1/docmind.git
cd docmind

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp packages/server/.env.example packages/server/.env
# Edit .env and fill in ANTHROPIC_API_KEY or ZHIPU_API_KEY

# 4. Start ChromaDB (optional, for semantic memory, requires Docker)
docker compose -f docker-compose.dev.yml up chroma -d

# 5. Start dev servers (in two separate terminals)
npm run dev:server   # http://localhost:3001
npm run dev:client   # http://localhost:5173
```

#### Docker (all-in-one)

```bash
cp packages/server/.env.example packages/server/.env
# Fill in your API key

docker compose -f docker-compose.dev.yml up --build
# Open http://localhost:5173
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API Key | — |
| `ANTHROPIC_MODEL` | Claude model | `claude-sonnet-4-5` |
| `ZHIPU_API_KEY` | Zhipu AI API Key | — |
| `ZHIPU_MODEL` | GLM models, comma-separated (auto-fallback) | `glm-4-flash` |
| `PORT` | Server port | `3001` |
| `CHROMA_URL` | ChromaDB URL | `http://localhost:8000` |

### Memory System Architecture

```
User sends message
   ↓
Semantic retrieval of relevant memories (ChromaDB top-3) ← fallback to FTS5
   ↓
Inject into System Prompt
   ↓
LLM generates reply (with memory context)
   ↓
Every 10 turns → Nudge silently extracts key facts → SQLite + ChromaDB
History too long → Smart Compact summarizes → extracts facts → SQLite + ChromaDB
```

### API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health |
| POST | `/api/chat/stream` | SSE streaming chat |
| POST | `/api/chat/compact` | Summarize history (returns summary + facts) |
| POST | `/api/chat/nudge` | Silent fact extraction |
| GET | `/api/memory` | List all memory notes |
| POST | `/api/memory/notes` | Add memory notes |
| POST | `/api/memory/search` | Semantic search memories |
| DELETE | `/api/memory/notes/:id` | Delete a memory note |
| DELETE | `/api/memory` | Clear all memories |
