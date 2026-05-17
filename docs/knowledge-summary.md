# DocMind 开发知识点总结

> 涵盖本项目开发过程中涉及的核心概念，适合回顾和查阅。

---

## 一、TypeScript 迁移

### 前后端配置差异

| 配置项 | 前端 (Vite) | 后端 (Node.js ESM) |
|--------|-------------|-------------------|
| `moduleResolution` | `"bundler"` | `"NodeNext"` |
| `module` | 不需要设置 | `"NodeNext"` |
| `jsx` | `"react-jsx"` | 不需要 |
| import 写法 | `import './foo'`（无扩展名） | `import './foo.js'`（必须带 `.js`） |
| 运行方式 | Vite 处理 | `tsx watch src/index.ts` |

**为什么后端 import 要写 `.js`？**
Node.js ESM 规范要求明确的文件扩展名。`tsx` 在运行时遇到 `.js` 会自动映射到实际的 `.ts` 文件，所以写 `.js` 是约定，并不是真的去找 `.js` 文件。

### tsx vs tsc

- `tsc`：编译器，把 `.ts` 编译成 `.js` 产物
- `tsx`：运行时，直接执行 `.ts` 文件，无需编译产物（开发用）
- `pnpm exec tsc --noEmit`：只做类型检查，不输出文件（CI 用）

### pnpm 环境注意

pnpm 不会把 `node_modules/.bin` 暴露给 `npx`。  
正确姿势：`pnpm exec tsc --noEmit`，而不是 `npx tsc`。

---

## 二、Embedding（向量嵌入）

### 是什么

Embedding 是把文字转换成数字向量的过程。例如：

```
"我是前端工程师" → [0.12, -0.34, 0.78, ...]  (1024 维)
"前端开发者"     → [0.11, -0.31, 0.75, ...]  (接近上面)
```

向量空间中语义相近的文本，距离也近。

### 为什么需要远程 API

向量化依赖预训练的神经网络模型（参数量很大）。本地运行需要 GPU 资源。  
本项目调用智谱 `embedding-3` API（云端计算），返回向量存到本地 ChromaDB。

### 本项目的分工

```
文本 → [Zhipu embedding-3 API] → 向量 → [ChromaDB (本地)] → 存储/检索
```

- ChromaDB：只负责向量的存储和相似度搜索，本身不做向量化
- 每次存记忆笔记时，先调 embedding API 生成向量，再存入 ChromaDB
- 检索时，把查询词向量化，再找 ChromaDB 里最近的向量

---

## 三、记忆系统架构

### 双存储设计

```
addNote(content)
    ├── SQLite (memory.db)      ← 持久化，FTS5 全文搜索
    └── ChromaDB                ← 向量存储，语义搜索
```

两者同步写入，检索时优先用 ChromaDB，不可用时降级到 FTS5。

### 记忆注入方式

记忆**不是**放进对话历史，而是注入到 **system prompt**：

```
[系统提示]
You are a helpful assistant...

--- 相关记忆 ---
- 用户是前端工程师
- 用户偏好简洁回答

--- 实时工具结果 ---
广州当前天气：阴天，26°C...
```

这样不会干扰对话结构，也不占用 history token 预算。

### FTS5 的中文限制

SQLite FTS5 默认用空格分词（适合英文）。中文没有空格，所以：

- 搜索"职业"无法匹配"我是前端工程师"
- 搜索"前端工程师"可以匹配（完整词组）

**解决方案**：用 Embedding + ChromaDB 做语义搜索，跨越分词限制。

### 三种写入来源

| 来源 | 触发时机 | 路由 |
|------|---------|------|
| `manual` | 用户在 MemoryPanel 手动添加 | `POST /api/memory` |
| `compact` | 用户触发历史压缩时，AI 提取事实 | `POST /api/chat/compact` |
| `nudge` | 每 N 条消息自动触发，AI 静默提取 | `POST /api/chat/nudge` |

---

## 四、Tool Use / Function Calling

### 核心概念

Tool Use 是一个**应用层协议**，不是模型内置能力：

1. 应用把"工具列表"发给模型
2. 模型决定是否要调用某个工具，返回结构化的调用意图（JSON）
3. **应用层**负责真正执行工具（查 API、读数据库等）
4. 把结果发回给模型，模型生成最终回答

模型本身不联网、不执行代码，只是"选择"调用哪个工具。

### 标准格式（OpenAI 兼容）

工具定义：
```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "获取指定城市的实时天气",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string", "description": "城市名称" }
      },
      "required": ["city"]
    }
  }
}
```

模型返回的 tool_call：
```json
{
  "tool_calls": [{
    "function": {
      "name": "get_weather",
      "arguments": "{\"city\": \"广州\"}"
    }
  }]
}
```

### 本项目的两阶段实现

```
用户消息
  │
  ▼
【第一阶段】非流式预检（max_tokens: 256）
  发送消息 + TOOLS 给 GLM-4.7
  ├── 不需要工具 → toolSection = ''
  └── 需要工具   → 执行 getWeather() → toolSection = '--- 实时工具结果 ---\n...'
  │
  ▼
【第二阶段】流式主请求
  system = [DEFAULT_SYSTEM, memSection, toolSection].join('\n\n')
  streamChat({ messages, system }) → SSE → 前端
```

为什么两阶段？流式请求无法中途拿到 tool_calls，需要先用非流式确认。

### 模型要求

- 智谱 GLM-4.7 及以上：支持 function calling
- glm-4-flash：**不支持** function calling（没有联网搜索）
- Anthropic Claude：支持，但本项目当前只对 zhipu provider 启用 tool 预检

---

## 五、SSE（Server-Sent Events）流式传输

### 协议格式

```
Content-Type: text/event-stream

data: {"text": "今天"}

data: {"text": "广州"}

data: {"done": true}

```

每条消息以 `data: ` 开头，两个换行结束。

### 前端读取方式

```ts
const reader = response.body.getReader()
const decoder = new TextDecoder()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const chunk = decoder.decode(value)
  // 解析 "data: {...}\n\n" 格式
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data: ')) {
      const payload = JSON.parse(line.slice(6))
      if (payload.text) appendToLast(payload.text)
      if (payload.done) break
    }
  }
}
```

### 后端写入方式（Fastify）

```ts
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
})

reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
reply.raw.end()
```

---

## 六、历史压缩与 Token 管理

### 为什么需要压缩

大多数 LLM 有上下文窗口限制（如 128k tokens）。无限追加历史最终会超限，且推理成本随长度线性增加。

### 本项目策略

```
token 估算 = Math.ceil(文本长度 / 3)   ← 字符数近似
```

- 前端累计 > 12000 tokens → 触发 compact
- compact 调用 `/api/chat/compact`，AI 生成摘要并提取事实
- 摘要替换旧历史，事实存入记忆系统
- server 侧 trimHistoryByTokens() 兜底，确保发给 LLM 的历史 ≤ 6000 tokens

### 固定消息（Pinned）

包含关键词（`记住这个`、`重要`等）的消息自动 pin。  
被 pin 的消息：
- 不参与 compact（永不被摘要替换）
- 不被 trimHistoryByTokens 裁剪
- 始终保留在发给 LLM 的历史中

---

## 七、ChromaDB

### 定位

ChromaDB 是一个**本地向量数据库**，专为 AI 应用设计。

- 存储：文本 + 对应的向量 + 元数据
- 检索：给定一个查询向量，找最相近的 N 条记录（余弦相似度）
- 本地运行：Docker 容器，数据持久化到 `chroma_data` volume

### 与传统数据库对比

| | 传统 DB (SQLite) | 向量 DB (ChromaDB) |
|--|------------|-------------|
| 检索方式 | 精确匹配 / 关键词 | 语义相似度 |
| 适合场景 | 精确查询 | "意思相近"的模糊查询 |
| 依赖 | 无 | 需要 embedding 模型 |

### 本项目用法

ChromaDB 有两个集合：`docmind_memory`（记忆笔记语义检索）和 `docmind_docs`（文档 chunk 的 RAG 检索，Milestone 2 已完成）。

---

## 八、wttr.in 天气 API

免费、无需 API Key 的天气服务。

```
GET https://wttr.in/{城市}?format=j1&lang=zh
```

返回 JSON，包含 `current_condition` 数组：
- `temp_C`：气温
- `FeelsLikeC`：体感温度
- `humidity`：湿度
- `windspeedKmph`：风速
- `lang_zh[0].value`：中文天气描述（如"阴天"）

项目设置了 8 秒超时（`AbortSignal.timeout(8000)`），失败时静默忽略不影响主流程。

---

## 九、RAG 自动化评估

### 核心方法：LLM-as-Judge

不需要人工标注。流程：

1. **测试集生成**：对文档每个 chunk 调 LLM 自动出题（问题 + 标准答案 + 难度），答案来源 chunk 记为 ground truth
2. **跑 pipeline**：每题走真实 RAG（检索 top-3 → 生成答案）
3. **四维打分**：
   - **召回率 Recall**：规则判断，检索到的 chunk 是否含 ground-truth（或答案文本是否出现在检索内容里）
   - **精确率 Precision**：LLM 判断检索到的 chunk 有多少真正有用
   - **忠实度 Faithfulness**：LLM 判断回答是否基于检索内容、无编造
   - **相关性 Relevancy**：LLM 判断回答是否切题、覆盖期望答案
4. 后三个用一次合并 LLM 调用（降 2/3 请求量）

业界等价物：RAGAs / LangSmith / TruLens，方法论一致，差别在工程化与精排算法。

### 速率限制（429）的踩坑

- **限流不一定返回 429**：GLM-4.7 配额耗尽时常表现为"请求挂起"（无响应也不报错），必须加**请求超时**（90s）兜底，否则进程无限死等
- **失败请求不计费，但超时被 abort 的请求服务端可能已跑完并计费**
- **本地 token 统计 ≠ 实际消耗**：只统计单轮成功调用，不含跨轮重试/重启累计，不能用于成本核算
- 应对：自适应节流（慢启动 12s → 成功缩小 / 429 翻倍）+ 退避重试 + 可续跑（保留成功结果只补失败的）

### 关键指标解读

- **召回率是最关键的前置指标**：检索没找到答案块，LLM 再强也答不对
- **精确率低 = 分块策略问题**：固定字符分块切断语义 → chunk 向量模糊 → 检索混入噪音
- **优化优先级**：Rerank（粗召回+精排）> 按章节分块（父子 chunk）> Query 改写 > 混合检索

### Node 日志缓冲坑

`console.log` 重定向到文件时块缓冲，长任务日志看不到实时输出。`console.error`（stderr）写文件是同步的，长进程进度日志应走 stderr。
