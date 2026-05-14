# DocMind RAG 自动化评估系统设计

## 目标

为 DocMind 的 RAG 链路建立**可量化、可重复、无需人工标注**的评估体系。让"改了分块策略效果好不好"、"换了 embedding 模型有没有提升"这类问题有数据可依。

## 背景

当前 DocMind 已实现：
- PDF 上传 → 分块（500字符）→ 向量化（Zhipu）→ ChromaDB 存储
- 提问时检索 top-3 chunk 注入 system prompt
- LLM 流式回答

但没有任何评估手段，无法判断：
1. 分块策略是否合理
2. 检索是否命中真正相关的内容
3. 回答是否忠实于文档、是否切题
4. 修改参数后整体效果变好还是变差

## 设计原则

1. **自动生成测试集** — 不依赖人工标注，用 LLM 从已上传文档生成 Q&A
2. **LLM-as-Judge** — 用 GLM-4.7 自动评分，业界标准方案
3. **持久化结果** — 每次评估存 SQLite，支持版本对比
4. **复用现有架构** — 不引入新依赖（不上 LangChain / RAGAs）
5. **MVP 优先** — 先打通端到端，UI 简化

## 架构

```
┌──────────────────────────────────────────────────────┐
│                    Evaluation Module                  │
├──────────────────────────────────────────────────────┤
│  1. Generator    生成测试集（LLM 从 chunk 出题）       │
│  2. Runner       跑评估（pipeline + scoring）         │
│  3. Reporter     展示结果（API + UI 列表）            │
└──────────────────────────────────────────────────────┘
              │              │              │
              ▼              ▼              ▼
       eval_test_sets  eval_runs   eval_results (SQLite)
```

## 数据模型

四张新表，全部存在 `data/memory.db`（复用现有 SQLite）：

```sql
-- 测试集（一个文档可以有多个版本的测试集）
CREATE TABLE eval_test_sets (
  id            TEXT PRIMARY KEY,
  doc_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  case_count    INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

-- 测试用例（每个 case = 一个问答对）
CREATE TABLE eval_cases (
  id                     TEXT PRIMARY KEY,
  test_set_id            TEXT NOT NULL,
  question               TEXT NOT NULL,
  expected_answer        TEXT NOT NULL,
  ground_truth_chunk_id  TEXT NOT NULL,   -- 答案应该来自哪个 chunk
  difficulty             TEXT NOT NULL,   -- easy | medium | hard
  FOREIGN KEY (test_set_id) REFERENCES eval_test_sets(id) ON DELETE CASCADE
);

-- 评估运行（每次跑一遍是一个 run）
CREATE TABLE eval_runs (
  id                       TEXT PRIMARY KEY,
  test_set_id              TEXT NOT NULL,
  config_snapshot          TEXT NOT NULL,   -- JSON: 分块、topK、模型等
  status                   TEXT NOT NULL,   -- running | done | failed
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  -- 聚合指标（finished 后填充）
  avg_context_recall       REAL,
  avg_context_precision    REAL,
  avg_faithfulness         REAL,
  avg_answer_relevancy     REAL,
  FOREIGN KEY (test_set_id) REFERENCES eval_test_sets(id)
);

-- 单条结果
CREATE TABLE eval_results (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  case_id               TEXT NOT NULL,
  retrieved_chunk_ids   TEXT NOT NULL,   -- JSON 数组
  generated_answer      TEXT NOT NULL,
  context_recall        REAL,
  context_precision     REAL,
  faithfulness          REAL,
  answer_relevancy      REAL,
  judge_reasoning       TEXT,            -- LLM judge 的理由（便于排查）
  FOREIGN KEY (run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
);
```

## 核心模块

### 1. Generator（`services/evalGenerator.ts`）

输入：`docId`
输出：N 个测试用例存入 `eval_cases`

```typescript
async function generateTestSet(docId: string, casesPerChunk = 2): Promise<TestSet>
```

实现要点：
- 取 `documents` 表里该文档的所有 chunk（通过 ChromaDB 反查）
- 对每个 chunk 调用 LLM 生成 2-3 个问答对
- Prompt 要求生成事实型 / 推理型问题，附带 difficulty 标签
- `ground_truth_chunk_id` 记为该 chunk 的 id

**生成 Prompt 模板**：
```
你是 RAG 评估数据集生成器。基于以下文档片段，生成 2-3 个用户可能提问的问题。

要求：
- 问题答案必须能从该片段中找到
- 涵盖事实型（数字/时间/规则）和理解型问题
- 问题要自然、口语化
- 标注难度：easy（直接事实）/ medium（需理解）/ hard（多概念关联）

片段：
{chunk_content}

输出 JSON 数组：
[{"question": "...", "expected_answer": "...", "difficulty": "easy"}]
```

### 2. Runner（`services/evalRunner.ts`）

输入：`testSetId`
输出：一个 `eval_run` 记录及其所有 `eval_results`

```typescript
async function runEvaluation(testSetId: string): Promise<EvalRun>
```

流程：
1. 创建 `eval_runs` 记录，status=running，快照当前配置
2. 取出所有 cases
3. 对每个 case：
   - 调用真实 pipeline：`searchChunks(question, [docId], 3)`
   - 调用 LLM 生成答案（同 chat 接口逻辑）
   - 调用 Judge 评分
   - 插入 `eval_results`
4. 聚合所有结果，更新 `eval_runs` 的平均分和 status=done

### 3. Judge（`services/evalJudge.ts`）

四个独立的评分函数，输入输出统一：

```typescript
async function scoreContextRecall(
  retrievedChunkIds: string[],
  groundTruthChunkId: string,
): Promise<number>  // 0 or 1，规则判断，不调用 LLM

async function scoreContextPrecision(
  question: string,
  retrievedChunks: DocumentChunk[],
): Promise<number>  // 0-1，LLM judge

async function scoreFaithfulness(
  answer: string,
  retrievedChunks: DocumentChunk[],
): Promise<{ score: number; reasoning: string }>

async function scoreAnswerRelevancy(
  question: string,
  answer: string,
  expected: string,
): Promise<{ score: number; reasoning: string }>
```

**Judge Prompt 示例（Faithfulness）**：
```
判断 AI 的回答是否完全基于提供的文档片段。

问题：{question}
AI 回答：{answer}
文档片段：{chunks}

打分（0-1）：
- 1.0：回答完全来自片段，无编造
- 0.5：部分来自片段，有合理推断但混入了外部知识
- 0.0：明显编造或与片段矛盾

输出 JSON：{ "score": 0.x, "reasoning": "...", "hallucinations": ["编造的内容1", ...] }
```

### 4. API 路由（`routes/eval.ts`）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/eval/generate` | body: `{ docId, casesPerChunk? }` 生成测试集 |
| GET | `/api/eval/test-sets` | 列出所有测试集 |
| GET | `/api/eval/test-sets/:id` | 测试集详情（含所有 cases） |
| DELETE | `/api/eval/test-sets/:id` | 删除测试集 |
| POST | `/api/eval/runs` | body: `{ testSetId }` 触发评估 |
| GET | `/api/eval/runs` | 列出所有评估记录 |
| GET | `/api/eval/runs/:id` | 单次评估详情（含所有 results） |

### 5. 前端 UI（`components/EvalPanel.tsx`）

简化的列表 + 详情，不做花哨可视化：

```
┌─────────────────────────────────────┐
│  📊 评估                            │
├─────────────────────────────────────┤
│  文档：[企业行为准则.pdf ▼]          │
│  [生成测试集] [运行评估]            │
│                                      │
│  测试集：v1 (38 cases)               │
├─────────────────────────────────────┤
│  📈 评估历史                         │
│  ┌──────────────────────────────┐   │
│  │ Run #3  ·  2分钟前            │   │
│  │ 召回 80% │ 忠实 92% │ 相关 73%│   │
│  │ [详情]                       │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

详情页：展示每个 case 的问题、检索到的 chunk、生成的答案、4 个分数、judge reasoning。

## MVP 范围

**包含**：
- ✅ 测试集生成（自动）
- ✅ 评估运行
- ✅ 四个核心指标
- ✅ 结果持久化
- ✅ 简单列表 UI

**不包含（后续迭代）**：
- ❌ 测试用例手工编辑
- ❌ 多次 run 对比图表
- ❌ CI 集成
- ❌ 流式评估进度（先用阻塞式，前端 polling 或显示 loading）
- ❌ 分难度统计

## 关键设计决策

### 为什么用 GLM-4.7 做 Judge
- 现有项目已配置该模型
- 中文理解能力强
- 同一模型自评有偏差，但项目里 Judge 主要是评估**检索质量**和**忠实度**，对生成质量的偏差影响较小

### 为什么不引入 RAGAs
- 主要支持 OpenAI
- 中文 prompt 适配差
- 自建 100 行代码，可控性更高

### 为什么测试集和评估分开（不一次性跑）
- 测试集生成耗时（每个 chunk 调一次 LLM）
- 同一个测试集可以跑多次（改参数后重测）
- 失败可以单独重试

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| LLM 生成的问题质量不稳定 | 加 difficulty 标签，可手工剔除明显错的；后续支持编辑 |
| 评估很慢（每 case 4 次 LLM 调用） | 第一版接受 5-10分钟/次，后续可并发 |
| Judge 模型对自己的回答有偏好 | 在 prompt 里强调"基于事实判断"；后续可换不同模型做 Judge |
| 测试集会过时（文档变了） | 删除文档时级联删除测试集 |

## 验收标准

完成 MVP 后能做到：
1. 选一个已上传的 PDF，点击"生成测试集"，30秒内拿到 30+ Q&A
2. 点击"运行评估"，5-10分钟后看到 4 个平均分
3. 点击 run 详情，能看到每个 case 的检索结果和评分理由
4. 删除测试集后，相关数据全部清理
5. 评估过程不阻塞正常聊天功能

## 后续可拓展方向（不在本次范围）

- 多模型对比（同样的测试集跑不同 LLM）
- 分块策略 A/B 测试
- 检索参数（topK, similarity threshold）扫参
- 失败 case 的自动归因（是检索问题还是生成问题）
- 导出/导入测试集（JSON 格式）
