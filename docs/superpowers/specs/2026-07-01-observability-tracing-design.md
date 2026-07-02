# DocMind 可观测性 · 请求级 Tracing 设计

- 日期：2026-07-01
- 状态：已定稿（待实现）
- 范围：chat 管线的请求级 tracing（trace/span + degraded 捕获），落 SQLite，管理员可查

## 1. 背景与目标

AI 管线是多段、非确定性的：一条用户消息要经过记忆检索、文档检索、工具预检、
prompt 拼装、LLM 生成等多个阶段，同样输入再跑一次结果可能不同。表面症状（"回答不对"）
背后可能对应多个不同阶段的根因，且**无法可靠复现**——所以必须在问题发生的那一刻
就捕获完整现场。

DocMind 现状：只有 `LOG_LLM` / `LOG_RETRIEVAL` 两个非结构化的 `console` 开关，
默认关闭、写 stderr、按调用点打印，**没有 traceId、没有 span、没有状态、请求之间无法关联**。
更糟的是大量降级路径（向量不可用→FTS、检索没过阈值→minK、模型额度耗尽→切模型、
历史超预算→裁剪）和 `.catch(()=>{})` 吞掉的写入失败，全都**静默无感**——正是
"表面成功率 100%、用户却觉得越来越笨"的隐患。

目标：给 chat 管线装上"黑匣子"。每次请求自动记录一棵 span 树（每阶段的耗时、
输入输出摘要、状态），把散落的降级点显式标成 `degraded`，落进 SQLite，管理员能
按 traceId "打开那次请求看现场"，并能统计降级率。

## 2. 范围

**纳入**：chat 管线的三个端点，每个 HTTP 请求 = 一个 trace
- `POST /api/chat/stream`
- `POST /api/chat/nudge`
- `POST /api/chat/compact`

**不纳入**（YAGNI / 后续）：eval 管线、memory/documents CRUD 接口、前端可视化面板、
OpenTelemetry / 外部平台导出、Metrics 指标系统、自动采样（低流量全量捕获）。

## 3. 关键决策（已确认）

| 决策 | 选择 |
|---|---|
| trace 落点 / 消费 | **SQLite 表 + `GET /api/traces` 接口**（管理员可见，按 traceId 拉完整树） |
| 埋点范围 | **只 chat 管线** |
| span 捕获深度 | **截断正文（每段 ≤500 字）+ 元数据**，默认开，`TRACE_CONTENT=off` 只留元数据 |
| 保留策略 | **不自动清理**（流量低，手动管） |
| 埋点机制 | **AsyncLocalStorage 环境式 tracer**（跨模块零签名侵入） |

## 4. 架构与组件

### 新增文件
- `services/tracing.ts` — 核心。`AsyncLocalStorage<Tracer>` + `Tracer`（trace 级，持 span 缓冲区）。
  导出：`runInTrace(meta, fn)`、`withSpan(name, {input?}, fn)`、`markDegraded(reason, meta?)`、
  `spanMeta(k, v)`、`currentTraceId()`。`TRACING=off` 时全部退化为直接执行 fn / 空操作。
- `services/traceStore.ts` — SQLite 读写，复用现有 `data/memory.db` 连接（与 documentStore/evalStore 同模式）。
  `initTraceTables(db)`、`saveTrace(trace, spans)`、`listTraces(filters)`、`getTrace(id)`、
  `appendSpan(traceId, span)`（迟到追加 + 更新汇总）、`traceStats(filters)`。
- `routes/traces.ts` — `GET /api/traces`、`GET /api/traces/:id`、`GET /api/traces/stats`，均 `requireAdmin`。

### 改动的现有文件（靠 ALS，零签名侵入）
- `routes/chat.ts` — 三端点各包 `runInTrace`；`/chat/stream` 各阶段包 `withSpan`。
- `services/documentVector.ts` — `searchChunks` 的 minK 兜底处加一行 `markDegraded('doc_retrieval_minK', …)`。
- `services/llm.ts` — `streamZhipu` 模型回退处加一行 `markDegraded('llm_model_fallback', …)`。
- `index.ts` — 注册 `initTraceTables` + `traceRoutes`。
- `routes/auth.ts` — 抽出共享 `requireUser` / `requireAdmin`（eval.ts 与 traces.ts 复用）。

### 数据流（一次 `/chat/stream`）
```
请求 → runInTrace(reqId,user) 建 Tracer 放进 ALS
  ├ withSpan('memory_retrieval')  → 回落 FTS 时 markDegraded('memory_fts_fallback')
  ├ withSpan('doc_retrieval')     → minK 兜底 markDegraded('doc_retrieval_minK')   （前三个并发跑在 Promise.all）
  ├ withSpan('tool_preflight')    → 失败 markDegraded('tool_preflight_failed')
  ├ withSpan('prompt_assembly')   → 历史被裁 markDegraded('history_trimmed')
  └ withSpan('llm_generation')    → 模型回退 markDegraded('llm_model_fallback')
请求结束(finally, reply.raw.end 之后) → tracer 把整棵 span 树一次性事务写入 SQLite
```

## 5. 数据模型

复用 `data/memory.db`。两张表：`traces`（每请求一行摘要，供列表 + 降级统计）+
`trace_spans`（每阶段一行明细，供详情树）。

```sql
CREATE TABLE traces (
  id             TEXT PRIMARY KEY,   -- tr_<time>_<rand>
  route          TEXT NOT NULL,      -- /chat/stream | /chat/nudge | /chat/compact
  user_id        TEXT,
  status         TEXT NOT NULL,      -- ok | degraded | error（roll-up 汇总）
  duration_ms    INTEGER NOT NULL,
  span_count     INTEGER NOT NULL,
  degraded_count INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE trace_spans (
  id              TEXT PRIMARY KEY,   -- sp_...
  trace_id        TEXT NOT NULL,
  parent_span_id  TEXT,               -- null = 顶层
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,      -- ok | degraded | error
  start_offset_ms INTEGER NOT NULL,   -- 相对 trace 起点（画瀑布/缩进）
  duration_ms     INTEGER NOT NULL,
  degraded_reason TEXT,               -- 一等列，支持按原因聚合
  input           TEXT,               -- 截断正文 or 元数据（TRACE_CONTENT=off 时省正文）
  output          TEXT,
  metadata        TEXT,               -- JSON: {model, scores, topK, tokens, ttfb_ms, ...}
  error_message   TEXT,
  FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
);
CREATE INDEX idx_spans_trace  ON trace_spans(trace_id);
CREATE INDEX idx_traces_status ON traces(status);
```

- `traces.status` = **roll-up 汇总**：任一 span 为 error → error；否则任一 degraded → degraded；否则 ok。
  落库时算好，配合 `degraded_count`/`error_count`，列表与统计不必扫 spans。
- `start_offset_ms` 存相对偏移，直接支持瀑布/缩进视图；并发 span 的偏移会重叠，正常。
- `degraded_reason` 提为一等列，支持：
  ```sql
  SELECT degraded_reason, COUNT(*) FROM trace_spans
  WHERE status='degraded' GROUP BY degraded_reason;
  ```

## 6. Span 边界

### `/chat/stream`（5 个顶层 span）
| span | 包住 | metadata |
|---|---|---|
| `memory_retrieval` | `getRelevantNotes` | path(vector/fts)、命中数、最高分 |
| `doc_retrieval` | `getRelevantChunks`（有附文档才有） | 候选数、保留数、阈值、距离分布 |
| `tool_preflight` | `runToolsIfNeeded`（仅 zhipu） | 是否调用、city |
| `prompt_assembly` | finalSystem 拼装 + `trimHistoryByTokens` | 最终 token、历史保留/裁剪条数 |
| `llm_generation` | 消费 `streamChat` 整个流 | provider、model、TTFB、输出 token、chunk 数 |

前三个跑在 `Promise.all` 里**并发**。并发正确性关键：tracer（trace 级、持 span 数组）
放 ALS 顶层共享；`currentSpan` 靠每个 `withSpan` 内部 `als.run(...)` 各自作用域——
`Promise.all` 三个分支各有各的 currentSpan，深层 `markDegraded` 能挂到对的 span（同 OTel context 做法）。

### `/chat/nudge`
`fact_extraction`(LLM) → `memory_write`

### `/chat/compact`
`summarize`(LLM) → `fact_extraction`(解析) → `memory_write`

## 7. degraded / error 判定清单（核心收益：当前全隐形）

| reason code | 位置 | 触发 | 级别 |
|---|---|---|---|
| `memory_vector_unavailable` | `getRelevantNotes` | ChromaDB 不可用，只走 FTS | degraded |
| `memory_fts_fallback` | `getRelevantNotes` | 向量返回 0 条，回落 FTS | degraded |
| `doc_vector_unavailable` | `getRelevantChunks` | 文档向量检索被关 | degraded |
| `doc_retrieval_minK` | `documentVector.searchChunks` | 无块过阈值，minK 兜底 | degraded |
| `tool_preflight_failed` | `runToolsIfNeeded` catch | 预检 LLM 抛错（原静默 `return ''`） | degraded |
| `history_trimmed` | `trimHistoryByTokens` | 历史超预算被裁 | degraded |
| `llm_model_fallback` | `llm.ts` streamZhipu | 额度耗尽切模型（原只 `console.warn`） | degraded |
| `memory_vector_write_failed` | `persistFacts`/upsert catch | ChromaDB 写失败（原 `.catch(()=>{})` 吞掉） | degraded |
| （llm_generation 抛错） | `streamChat` | 所有模型失败 / API 500 | **error** |

**级别取舍**：向量写入失败标 **degraded 而非 error**——笔记已存 SQLite（FTS 仍能搜到），
只是没进向量库，对话也没断。这正是"表面成功、悄悄降级"，标 degraded 让它被看见而不误报为崩溃。

## 8. 捕获内容（截断 ≤500 字；`TRACE_CONTENT=off` 只留元数据）

- `memory_retrieval`：input=query；output=命中记忆正文
- `doc_retrieval`：input=query；output=保留块 `[文件·块N] 正文`
- `prompt_assembly`：output=最终 system prompt（用于排查"检索到了但没进 prompt"）
- `llm_generation`：input=最终 messages 摘要；output=模型回复

## 9. 查询接口（`routes/traces.ts`，全部 `requireAdmin`）

- `GET /api/traces?status=&route=&limit=50` — 列表（只读 traces 摘要），时间倒序。
- `GET /api/traces/:id` — trace 行 + 全部 spans（按 `start_offset_ms` 排）= 缩进树。
- `GET /api/traces/stats` — `{ total, degradedPct, byReason: {...} }`，回答"降级率是否在升高"。

**不做前端面板**（YAGNI）：JSON 接口已能"打开 trace 看现场"。React 面板作为独立后续。

## 10. 流式 / 异步细节

- **llm_generation span**：包住路由 `for await (const text of stream)` 整段，记 TTFB、总耗时、
  输出 token(≈char/3)。span 关闭 + trace 落库在流结束后的 `finally`（`reply.raw.end()` 之后）。
- **ALS 穿 async generator（要在实现时验证的风险点）**：`llm_model_fallback` 的 `markDegraded`
  在 `streamZhipu`（异步生成器）深处调用，需 ALS 上下文穿过 generator 恢复点找到 `llm_generation` span。
  新版 Node 支持，但属 ALS 易错区。**兜底**：若穿不过去，只给 `streamChat` 这一个边界函数显式传 tracer，
  其它模块仍零侵入。
- **迟到 span**：`upsertNote/upsertChunks` 是 fire-and-forget，请求返回时 trace 可能已落库。
  调度前先从 ALS 抓 `traceId` 闭包起来；`.catch(err => appendSpan(traceId, {name:'memory_vector_write',
  status:'degraded', reason:'memory_vector_write_failed', error}))`。`appendSpan` = 插一条 span +
  `UPDATE traces SET degraded_count+1, status=roll-up`。终结原来的静默吞异常。

## 11. 配置开关

- `TRACING=off` → 全局关闭，`withSpan`/`markDegraded` 变空操作（零开销）。**默认开**。
- `TRACE_CONTENT=off` → 只存元数据、不存正文（更严隐私）。
- `LOG_LLM` / `LOG_RETRIEVAL` 保持原样（即时 console 调试，与持久化 trace 正交）。

## 12. 健壮性（硬要求）

**埋点绝不能弄坏请求**：所有 tracing 操作内部 try/catch；落库失败只打 warn、照常返回响应。
可观测性是旁路。

## 13. 测试

DocMind 现零测试，借此引入最轻的 `node:test`（Node 内置，零依赖）：
- 纯逻辑单测：status roll-up、正文截断、span 树组装、degraded 计数。
- `traceStore` 往返测：写 trace+spans 到临时 SQLite → `getTrace` 读回对得上；
  `appendSpan` 迟到追加后 `degraded_count` 正确 +1、`status` 正确升级。

## 14. 非目标

eval/CRUD 埋点、前端面板、OTel/外部平台、Metrics 导出、自动采样、trace 自动清理。

## 15. 主要风险

AsyncLocalStorage 穿过 async generator 恢复点的上下文传播（见 §10）——实现时优先验证
`llm_model_fallback` 能挂到正确 span，不行则退回"只给 streamChat 显式传 tracer"。
