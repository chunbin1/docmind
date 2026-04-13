# DocMind — 智能文档问答系统

基于 RAG（检索增强生成）的文档问答应用，支持上传 PDF/TXT 文档，通过语义检索 + LLM 实现精准问答。

![CI](https://github.com/your-username/docmind/actions/workflows/ci.yml/badge.svg)

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite + CSS Modules |
| 后端 | Node.js + Fastify |
| AI 框架 | LangChain.js + Anthropic Claude |
| 向量数据库 | ChromaDB |
| 部署 | Docker Compose + GitHub Actions |

## 功能

- [x] 流式对话（SSE）
- [ ] PDF / TXT 文档上传与解析
- [ ] 文档向量化（Embedding + ChromaDB）
- [ ] RAG 问答（语义检索 + 重排序）
- [ ] 引用来源标注
- [ ] 检索质量评测工具

## 快速开始

### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/your-username/docmind.git
cd docmind

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp packages/server/.env.example packages/server/.env
# 编辑 .env，填入你的 ANTHROPIC_API_KEY

# 4. 启动 Chroma（需要 Docker）
docker compose up chroma -d

# 5. 启动开发服务器（两个终端）
npm run dev:server   # http://localhost:3001
npm run dev:client   # http://localhost:5173
```

### Docker 一键启动

```bash
cp packages/server/.env.example packages/server/.env
# 填入 ANTHROPIC_API_KEY

docker compose up --build
# 访问 http://localhost:5173
```

## 项目结构

```
docmind/
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── index.js          # Fastify 入口
│   │       └── routes/
│   │           ├── chat.js       # 流式对话 API
│   │           └── documents.js  # 文档管理 API
│   └── client/
│       └── src/
│           ├── App.jsx
│           ├── hooks/
│           │   └── useChat.js    # 流式请求逻辑
│           └── components/
│               ├── Message.jsx
│               └── ChatInput.jsx
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## RAG 架构

```
上传文档
   ↓
文本提取（pdf-parse）
   ↓
智能分块（RecursiveCharacterTextSplitter）
   ↓
Embedding（claude-3-haiku / text-embedding-3-small）
   ↓
写入 ChromaDB
   ↓
用户提问 → 语义检索 → 重排序 → Prompt 组装 → Claude 生成
```

## API 文档

### `POST /api/chat/stream`

流式对话接口，返回 SSE 数据流。

**Request Body**
```json
{
  "message": "你好",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Response** — SSE 格式
```
data: {"text": "你"}
data: {"text": "好"}
data: {"done": true}
```
