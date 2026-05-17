# RAG 自动化评估系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DocMind 加上一套端到端的 RAG 自动化评估系统：从已上传文档自动生成测试集，跑 4 个核心指标，结果持久化并可在前端查看。

**Architecture:**
- 后端：4 张 SQLite 表 + 3 个 service（Generator / Runner / Judge）+ 1 个 routes 文件
- 前端：1 个 hook（useEval）+ 1 个面板组件（EvalPanel）+ 1 个详情组件（EvalRunDetail）
- LLM：使用 GLM-4.7 做生成和 Judge，复用现有 `streamChat`/`OpenAI` SDK 调用模式

**Tech Stack:** TypeScript + Fastify + better-sqlite3 + React 19 + Zhipu GLM-4.7

**Verification approach:** 该项目无 unit test 框架。每个 task 用 **`tsc --noEmit` 类型检查 + curl 烟测**验证。

---

## 文件结构总览

新增文件：
- `packages/server/src/services/evalStore.ts` — SQLite CRUD（4 张表）
- `packages/server/src/services/evalGenerator.ts` — LLM 生成测试集
- `packages/server/src/services/evalJudge.ts` — LLM-as-Judge 4 个评分函数
- `packages/server/src/services/evalRunner.ts` — 运行评估的编排逻辑
- `packages/server/src/routes/eval.ts` — 7 个 HTTP 端点
- `packages/client/src/hooks/useEval.ts` — 前端数据管理
- `packages/client/src/components/EvalPanel.tsx` + CSS — 主面板
- `packages/client/src/components/EvalRunDetail.tsx` + CSS — 详情页

修改文件：
- `packages/server/src/types.ts` — 新增评估相关类型
- `packages/server/src/services/documentVector.ts` — 暴露"取该文档所有 chunk"的方法
- `packages/server/src/index.ts` — 注册 routes + 初始化表
- `packages/client/src/App.tsx` — 接入 EvalPanel
- `packages/client/src/types.ts` — 同步前端类型

---

## Task 1: 后端类型定义

**Files:**
- Modify: `packages/server/src/types.ts`

- [ ] **Step 1: 在 `types.ts` 末尾追加评估相关类型**

```typescript
// === Evaluation types ===

export type EvalDifficulty = 'easy' | 'medium' | 'hard'
export type EvalRunStatus = 'running' | 'done' | 'failed'

export interface EvalTestSet {
  id: string
  doc_id: string
  name: string
  case_count: number
  created_at: string
}

export interface EvalCase {
  id: string
  test_set_id: string
  question: string
  expected_answer: string
  ground_truth_chunk_id: string
  difficulty: EvalDifficulty
}

export interface EvalConfigSnapshot {
  chunkSize: number
  overlap: number
  topK: number
  model: string
  embedModel: string
}

export interface EvalRun {
  id: string
  test_set_id: string
  config_snapshot: string  // JSON string of EvalConfigSnapshot
  status: EvalRunStatus
  started_at: string
  finished_at: string | null
  avg_context_recall: number | null
  avg_context_precision: number | null
  avg_faithfulness: number | null
  avg_answer_relevancy: number | null
}

export interface EvalResult {
  id: string
  run_id: string
  case_id: string
  retrieved_chunk_ids: string  // JSON array of strings
  generated_answer: string
  context_recall: number | null
  context_precision: number | null
  faithfulness: number | null
  answer_relevancy: number | null
  judge_reasoning: string | null  // JSON string with reasoning per dimension
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/types.ts
git commit -m "feat(types): add evaluation domain types"
```

---

## Task 2: SQLite 评估存储层

**Files:**
- Create: `packages/server/src/services/evalStore.ts`

- [ ] **Step 1: 创建 `evalStore.ts` 完整实现**

```typescript
// packages/server/src/services/evalStore.ts
import type { DB } from './memoryStore.js'
import type {
  EvalTestSet,
  EvalCase,
  EvalRun,
  EvalRunStatus,
  EvalResult,
} from '../types.js'

let _db: DB | null = null

export function initEvalTables(db: DB): void {
  _db = db
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_test_sets (
      id          TEXT PRIMARY KEY,
      doc_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      case_count  INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_cases (
      id                     TEXT PRIMARY KEY,
      test_set_id            TEXT NOT NULL,
      question               TEXT NOT NULL,
      expected_answer        TEXT NOT NULL,
      ground_truth_chunk_id  TEXT NOT NULL,
      difficulty             TEXT NOT NULL,
      FOREIGN KEY (test_set_id) REFERENCES eval_test_sets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS eval_runs (
      id                       TEXT PRIMARY KEY,
      test_set_id              TEXT NOT NULL,
      config_snapshot          TEXT NOT NULL,
      status                   TEXT NOT NULL,
      started_at               TEXT NOT NULL,
      finished_at              TEXT,
      avg_context_recall       REAL,
      avg_context_precision    REAL,
      avg_faithfulness         REAL,
      avg_answer_relevancy     REAL,
      FOREIGN KEY (test_set_id) REFERENCES eval_test_sets(id)
    );

    CREATE TABLE IF NOT EXISTS eval_results (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      case_id               TEXT NOT NULL,
      retrieved_chunk_ids   TEXT NOT NULL,
      generated_answer      TEXT NOT NULL,
      context_recall        REAL,
      context_precision     REAL,
      faithfulness          REAL,
      answer_relevancy      REAL,
      judge_reasoning       TEXT,
      FOREIGN KEY (run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
    );
  `)
}

function db(): DB {
  if (!_db) throw new Error('evalStore not initialized — call initEvalTables() first')
  return _db
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// === Test Sets ===

export function createTestSet(opts: {
  doc_id: string
  name: string
  case_count: number
}): EvalTestSet {
  const id = genId('ts')
  const created_at = new Date().toISOString()
  db().prepare(
    'INSERT INTO eval_test_sets (id, doc_id, name, case_count, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, opts.doc_id, opts.name, opts.case_count, created_at)
  return { id, ...opts, created_at }
}

export function getAllTestSets(): EvalTestSet[] {
  return db()
    .prepare('SELECT * FROM eval_test_sets ORDER BY created_at DESC')
    .all() as EvalTestSet[]
}

export function getTestSet(id: string): EvalTestSet | null {
  return (db().prepare('SELECT * FROM eval_test_sets WHERE id = ?').get(id) as EvalTestSet) ?? null
}

export function deleteTestSet(id: string): void {
  db().prepare('DELETE FROM eval_test_sets WHERE id = ?').run(id)
}

// === Cases ===

export function insertCases(testSetId: string, cases: Array<{
  question: string
  expected_answer: string
  ground_truth_chunk_id: string
  difficulty: 'easy' | 'medium' | 'hard'
}>): EvalCase[] {
  const inserted: EvalCase[] = []
  const stmt = db().prepare(
    'INSERT INTO eval_cases (id, test_set_id, question, expected_answer, ground_truth_chunk_id, difficulty) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const c of cases) {
    const id = genId('case')
    stmt.run(id, testSetId, c.question, c.expected_answer, c.ground_truth_chunk_id, c.difficulty)
    inserted.push({ id, test_set_id: testSetId, ...c })
  }
  return inserted
}

export function getCasesByTestSet(testSetId: string): EvalCase[] {
  return db()
    .prepare('SELECT * FROM eval_cases WHERE test_set_id = ?')
    .all(testSetId) as EvalCase[]
}

// === Runs ===

export function createRun(opts: {
  test_set_id: string
  config_snapshot: string
}): EvalRun {
  const id = genId('run')
  const started_at = new Date().toISOString()
  db().prepare(
    'INSERT INTO eval_runs (id, test_set_id, config_snapshot, status, started_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, opts.test_set_id, opts.config_snapshot, 'running', started_at)
  return {
    id,
    test_set_id: opts.test_set_id,
    config_snapshot: opts.config_snapshot,
    status: 'running',
    started_at,
    finished_at: null,
    avg_context_recall: null,
    avg_context_precision: null,
    avg_faithfulness: null,
    avg_answer_relevancy: null,
  }
}

export function finishRun(id: string, opts: {
  status: EvalRunStatus
  avg_context_recall: number
  avg_context_precision: number
  avg_faithfulness: number
  avg_answer_relevancy: number
}): void {
  const finished_at = new Date().toISOString()
  db().prepare(`
    UPDATE eval_runs
    SET status = ?,
        finished_at = ?,
        avg_context_recall = ?,
        avg_context_precision = ?,
        avg_faithfulness = ?,
        avg_answer_relevancy = ?
    WHERE id = ?
  `).run(
    opts.status, finished_at,
    opts.avg_context_recall, opts.avg_context_precision,
    opts.avg_faithfulness, opts.avg_answer_relevancy,
    id,
  )
}

export function markRunFailed(id: string): void {
  db().prepare('UPDATE eval_runs SET status = ?, finished_at = ? WHERE id = ?')
    .run('failed', new Date().toISOString(), id)
}

export function getAllRuns(): EvalRun[] {
  return db()
    .prepare('SELECT * FROM eval_runs ORDER BY started_at DESC')
    .all() as EvalRun[]
}

export function getRun(id: string): EvalRun | null {
  return (db().prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as EvalRun) ?? null
}

// === Results ===

export function insertResult(opts: {
  run_id: string
  case_id: string
  retrieved_chunk_ids: string
  generated_answer: string
  context_recall: number
  context_precision: number
  faithfulness: number
  answer_relevancy: number
  judge_reasoning: string
}): EvalResult {
  const id = genId('res')
  db().prepare(`
    INSERT INTO eval_results
    (id, run_id, case_id, retrieved_chunk_ids, generated_answer,
     context_recall, context_precision, faithfulness, answer_relevancy, judge_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.run_id, opts.case_id, opts.retrieved_chunk_ids, opts.generated_answer,
    opts.context_recall, opts.context_precision, opts.faithfulness, opts.answer_relevancy,
    opts.judge_reasoning,
  )
  return { id, ...opts }
}

export function getResultsByRun(runId: string): EvalResult[] {
  return db()
    .prepare('SELECT * FROM eval_results WHERE run_id = ?')
    .all(runId) as EvalResult[]
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/services/evalStore.ts
git commit -m "feat(server): add evalStore SQLite service with 4 tables"
```

---

## Task 3: 暴露 documentVector 的 chunk 查询能力

**Files:**
- Modify: `packages/server/src/services/documentVector.ts`

Generator 需要按 docId 取出所有 chunk 的 id+content。当前只有 `searchChunks` 函数（按语义），需要加一个直接取全部的方法。

- [ ] **Step 1: 在 `documentVector.ts` 末尾追加 `getAllChunksByDoc` 函数**

```typescript
/**
 * 取出某文档的所有 chunk（按 chunk_index 排序），用于评估场景遍历所有块。
 */
export async function getAllChunksByDoc(docId: string): Promise<Array<{
  id: string
  chunk_index: number
  content: string
}>> {
  if (!_available || !_collection) return []
  try {
    const results = await _collection.get({
      where: { doc_id: { $eq: docId } },
      include: ['documents', 'metadatas'],
    })
    const ids = results.ids ?? []
    const documents = results.documents ?? []
    const metadatas = results.metadatas ?? []
    const chunks = ids.map((id, i) => ({
      id,
      chunk_index: Number((metadatas[i] as Record<string, unknown>)?.chunk_index ?? 0),
      content: documents[i] ?? '',
    }))
    return chunks.sort((a, b) => a.chunk_index - b.chunk_index)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] getAllChunksByDoc failed: ${msg}`)
    return []
  }
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/services/documentVector.ts
git commit -m "feat(server): expose getAllChunksByDoc on documentVector"
```

---

## Task 4: 评估生成器（Generator）

**Files:**
- Create: `packages/server/src/services/evalGenerator.ts`

- [ ] **Step 1: 创建 `evalGenerator.ts`**

```typescript
// packages/server/src/services/evalGenerator.ts
import OpenAI from 'openai'
import { getAllChunksByDoc } from './documentVector.js'
import { getDocument } from './documentStore.js'
import { createTestSet, insertCases, getAllTestSets } from './evalStore.js'
import type { EvalTestSet, EvalDifficulty } from '../types.js'

const MODEL = process.env.ZHIPU_MODEL ?? 'glm-4.7'

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })
}

interface GeneratedQA {
  question: string
  expected_answer: string
  difficulty: EvalDifficulty
}

function buildPrompt(chunkContent: string): string {
  return `你是 RAG 评估数据集生成器。基于以下文档片段，生成 2-3 个用户可能提问的问题。

要求：
- 问题答案必须能从该片段中找到
- 涵盖事实型（数字/时间/规则）和理解型问题
- 问题要自然、口语化
- 标注难度：easy（直接事实查找）/ medium（需要理解）/ hard（多概念关联）
- 严格输出 JSON 数组，不要任何额外文字

文档片段：
"""
${chunkContent}
"""

输出格式（必须是合法 JSON 数组）：
[{"question": "...", "expected_answer": "...", "difficulty": "easy"}]`
}

function parseGenerated(raw: string): GeneratedQA[] {
  // 模型可能用 ```json ... ``` 包裹，先剥掉
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is GeneratedQA =>
        typeof x === 'object' && x !== null &&
        typeof x.question === 'string' &&
        typeof x.expected_answer === 'string' &&
        ['easy', 'medium', 'hard'].includes(x.difficulty),
      )
  } catch {
    return []
  }
}

/**
 * 给指定文档生成测试集。会调 LLM 对每个 chunk 出题。
 */
export async function generateTestSet(docId: string): Promise<EvalTestSet> {
  const doc = getDocument(docId)
  if (!doc) throw new Error(`document not found: ${docId}`)

  const chunks = await getAllChunksByDoc(docId)
  if (chunks.length === 0) throw new Error(`no chunks found for ${docId} (ChromaDB unavailable?)`)

  const client = getClient()
  const allCases: Array<{
    question: string
    expected_answer: string
    ground_truth_chunk_id: string
    difficulty: EvalDifficulty
  }> = []

  for (const chunk of chunks) {
    // 跳过过短或近似空白的 chunk
    if (chunk.content.trim().length < 50) continue

    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(chunk.content) }],
        temperature: 0.3,
      })
      const raw = completion.choices[0]?.message?.content ?? ''
      const generated = parseGenerated(raw)
      for (const qa of generated) {
        allCases.push({
          question: qa.question,
          expected_answer: qa.expected_answer,
          ground_truth_chunk_id: chunk.id,
          difficulty: qa.difficulty,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[evalGenerator] chunk ${chunk.id} generation failed: ${msg}`)
    }
  }

  if (allCases.length === 0) throw new Error('No cases generated — all LLM calls failed')

  // 自动命名：<filename>-v<N>
  const existingCount = getAllTestSets().filter(ts => ts.doc_id === docId).length
  const name = `${doc.filename}-v${existingCount + 1}`

  const testSet = createTestSet({
    doc_id: docId,
    name,
    case_count: allCases.length,
  })
  insertCases(testSet.id, allCases)

  return testSet
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/services/evalGenerator.ts
git commit -m "feat(server): add evalGenerator service for auto Q&A generation"
```

---

## Task 5: LLM-as-Judge 评分模块

**Files:**
- Create: `packages/server/src/services/evalJudge.ts`

- [ ] **Step 1: 创建 `evalJudge.ts`**

```typescript
// packages/server/src/services/evalJudge.ts
import OpenAI from 'openai'
import type { DocumentChunk } from '../types.js'

const MODEL = process.env.ZHIPU_MODEL ?? 'glm-4.7'

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })
}

function parseScoreJSON(raw: string): { score: number; reasoning: string } {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned) as { score?: number; reasoning?: string }
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : ''
    return { score, reasoning }
  } catch {
    return { score: 0, reasoning: `parse failed: ${raw.slice(0, 200)}` }
  }
}

async function callJudge(prompt: string): Promise<{ score: number; reasoning: string }> {
  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    })
    const raw = completion.choices[0]?.message?.content ?? ''
    return parseScoreJSON(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { score: 0, reasoning: `judge call failed: ${msg}` }
  }
}

/**
 * 1. 检索召回率：规则判断 — retrieved 是否包含 ground truth
 */
export function scoreContextRecall(
  retrievedChunkIds: string[],
  groundTruthChunkId: string,
): number {
  return retrievedChunkIds.includes(groundTruthChunkId) ? 1 : 0
}

/**
 * 2. 检索精确率：LLM 判断 retrieved chunks 里有多少真正与问题相关
 */
export async function scoreContextPrecision(
  question: string,
  retrievedChunks: DocumentChunk[],
): Promise<{ score: number; reasoning: string }> {
  if (retrievedChunks.length === 0) return { score: 0, reasoning: 'no chunks retrieved' }

  const chunksText = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]\n${c.content}`)
    .join('\n\n')

  const prompt = `判断以下文档片段对回答问题是否有用。

问题：${question}

检索到的片段：
${chunksText}

打分 (0-1)：
- 1.0：所有片段都与问题强相关
- 0.5：部分片段相关
- 0.0：片段都与问题无关

严格输出 JSON：{"score": 0.x, "reasoning": "简短说明哪些相关哪些不相关"}`

  return callJudge(prompt)
}

/**
 * 3. 答案忠实度：判断回答是否完全基于检索内容，没有编造
 */
export async function scoreFaithfulness(
  answer: string,
  retrievedChunks: DocumentChunk[],
): Promise<{ score: number; reasoning: string }> {
  if (retrievedChunks.length === 0) return { score: 0, reasoning: 'no chunks to verify against' }

  const chunksText = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]\n${c.content}`)
    .join('\n\n')

  const prompt = `判断 AI 的回答是否完全基于提供的文档片段，没有编造或混入外部知识。

文档片段：
${chunksText}

AI 回答：
${answer}

打分 (0-1)：
- 1.0：回答完全来自片段，无编造
- 0.5：部分来自片段，有合理但未在片段中明确出现的内容
- 0.0：明显编造或与片段矛盾

严格输出 JSON：{"score": 0.x, "reasoning": "指出哪些内容来自片段、哪些是编造"}`

  return callJudge(prompt)
}

/**
 * 4. 答案相关性：判断回答是否切题、是否与期望答案一致
 */
export async function scoreAnswerRelevancy(
  question: string,
  answer: string,
  expected: string,
): Promise<{ score: number; reasoning: string }> {
  const prompt = `判断 AI 的回答是否切题、是否覆盖了期望答案的核心信息。

问题：${question}
期望答案：${expected}
AI 回答：${answer}

打分 (0-1)：
- 1.0：完全切题且包含期望答案的核心信息
- 0.5：部分切题或部分覆盖
- 0.0：答非所问或完全不一致

严格输出 JSON：{"score": 0.x, "reasoning": "对比期望与实际答案的差异"}`

  return callJudge(prompt)
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/services/evalJudge.ts
git commit -m "feat(server): add LLM-as-Judge scoring functions"
```

---

## Task 6: 评估运行器（Runner）

**Files:**
- Create: `packages/server/src/services/evalRunner.ts`

- [ ] **Step 1: 创建 `evalRunner.ts`**

```typescript
// packages/server/src/services/evalRunner.ts
import OpenAI from 'openai'
import { searchChunks } from './documentVector.js'
import {
  createRun,
  finishRun,
  markRunFailed,
  insertResult,
  getCasesByTestSet,
  getTestSet,
} from './evalStore.js'
import {
  scoreContextRecall,
  scoreContextPrecision,
  scoreFaithfulness,
  scoreAnswerRelevancy,
} from './evalJudge.js'
import type { EvalRun, EvalConfigSnapshot } from '../types.js'

const MODEL = process.env.ZHIPU_MODEL ?? 'glm-4.7'
const EMBED_MODEL = process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3'
const TOP_K = 3

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })
}

/**
 * 用问题 + 检索到的 chunk 生成答案（复用 chat pipeline 的 system prompt 模式）
 */
async function generateAnswer(
  question: string,
  chunks: Array<{ filename: string; chunk_index: number; content: string }>,
): Promise<string> {
  const docSection = chunks.length
    ? `--- 文档参考 ---\n${chunks.map(c => `[${c.filename} · 块${c.chunk_index}] ${c.content}`).join('\n')}`
    : ''
  const system = [
    'You are a helpful assistant. Answer concisely and clearly based on the provided document references.',
    docSection,
  ].filter(Boolean).join('\n\n')

  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      temperature: 0.2,
    })
    return completion.choices[0]?.message?.content ?? ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[generation failed: ${msg}]`
  }
}

/**
 * 跑一次完整评估：testSetId → 创建 run → 逐 case 评分 → 聚合 → 完成
 */
export async function runEvaluation(testSetId: string): Promise<EvalRun> {
  const testSet = getTestSet(testSetId)
  if (!testSet) throw new Error(`test set not found: ${testSetId}`)

  const cases = getCasesByTestSet(testSetId)
  if (cases.length === 0) throw new Error(`test set ${testSetId} has no cases`)

  const config: EvalConfigSnapshot = {
    chunkSize: 500,
    overlap: 50,
    topK: TOP_K,
    model: MODEL,
    embedModel: EMBED_MODEL,
  }
  const run = createRun({
    test_set_id: testSetId,
    config_snapshot: JSON.stringify(config),
  })

  const totals = {
    context_recall: 0,
    context_precision: 0,
    faithfulness: 0,
    answer_relevancy: 0,
    count: 0,
  }

  try {
    for (const c of cases) {
      const retrievedChunks = await searchChunks(c.question, [testSet.doc_id], TOP_K)
      const retrievedIds = retrievedChunks.map(rc => `${testSet.doc_id}_chunk_${rc.chunk_index}`)
      const answer = await generateAnswer(c.question, retrievedChunks)

      const recall = scoreContextRecall(retrievedIds, c.ground_truth_chunk_id)
      const [precision, faithfulness, relevancy] = await Promise.all([
        scoreContextPrecision(c.question, retrievedChunks),
        scoreFaithfulness(answer, retrievedChunks),
        scoreAnswerRelevancy(c.question, answer, c.expected_answer),
      ])

      const reasoning = JSON.stringify({
        precision: precision.reasoning,
        faithfulness: faithfulness.reasoning,
        relevancy: relevancy.reasoning,
      })

      insertResult({
        run_id: run.id,
        case_id: c.id,
        retrieved_chunk_ids: JSON.stringify(retrievedIds),
        generated_answer: answer,
        context_recall: recall,
        context_precision: precision.score,
        faithfulness: faithfulness.score,
        answer_relevancy: relevancy.score,
        judge_reasoning: reasoning,
      })

      totals.context_recall += recall
      totals.context_precision += precision.score
      totals.faithfulness += faithfulness.score
      totals.answer_relevancy += relevancy.score
      totals.count += 1
    }

    const n = Math.max(1, totals.count)
    finishRun(run.id, {
      status: 'done',
      avg_context_recall: totals.context_recall / n,
      avg_context_precision: totals.context_precision / n,
      avg_faithfulness: totals.faithfulness / n,
      avg_answer_relevancy: totals.answer_relevancy / n,
    })
    return { ...run, status: 'done' }
  } catch (err) {
    markRunFailed(run.id)
    throw err
  }
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/services/evalRunner.ts
git commit -m "feat(server): add evalRunner orchestration service"
```

---

## Task 7: 评估路由（API）

**Files:**
- Create: `packages/server/src/routes/eval.ts`

- [ ] **Step 1: 创建 `eval.ts`**

```typescript
// packages/server/src/routes/eval.ts
import type { FastifyPluginAsync } from 'fastify'
import {
  getAllTestSets,
  getTestSet,
  deleteTestSet,
  getCasesByTestSet,
  getAllRuns,
  getRun,
  getResultsByRun,
} from '../services/evalStore.js'
import { generateTestSet } from '../services/evalGenerator.js'
import { runEvaluation } from '../services/evalRunner.js'

interface GenerateBody { docId: string }
interface RunBody { testSetId: string }

export const evalRoutes: FastifyPluginAsync = async (app) => {
  // 生成测试集（阻塞式，可能耗时 30s+）
  app.post<{ Body: GenerateBody }>('/eval/generate', async (req, reply) => {
    const { docId } = req.body
    if (!docId) return reply.code(400).send({ error: 'docId required' })
    try {
      const testSet = await generateTestSet(docId)
      return testSet
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 列出所有测试集
  app.get('/eval/test-sets', async () => ({
    testSets: getAllTestSets(),
  }))

  // 测试集详情（含所有 cases）
  app.get<{ Params: { id: string } }>('/eval/test-sets/:id', async (req, reply) => {
    const testSet = getTestSet(req.params.id)
    if (!testSet) return reply.code(404).send({ error: 'test set not found' })
    const cases = getCasesByTestSet(testSet.id)
    return { testSet, cases }
  })

  // 删除测试集（级联删除 cases）
  app.delete<{ Params: { id: string } }>('/eval/test-sets/:id', async (req) => {
    deleteTestSet(req.params.id)
    return { ok: true }
  })

  // 触发一次评估（阻塞式，可能耗时几分钟）
  app.post<{ Body: RunBody }>('/eval/runs', async (req, reply) => {
    const { testSetId } = req.body
    if (!testSetId) return reply.code(400).send({ error: 'testSetId required' })
    try {
      const run = await runEvaluation(testSetId)
      return run
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 列出所有运行
  app.get('/eval/runs', async () => ({
    runs: getAllRuns(),
  }))

  // 运行详情（含所有 results）
  app.get<{ Params: { id: string } }>('/eval/runs/:id', async (req, reply) => {
    const run = getRun(req.params.id)
    if (!run) return reply.code(404).send({ error: 'run not found' })
    const results = getResultsByRun(run.id)
    return { run, results }
  })
}
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/routes/eval.ts
git commit -m "feat(server): add evaluation HTTP routes"
```

---

## Task 8: 启动时挂载 eval 模块

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: 修改 `index.ts`**

把 imports 部分改成：

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import 'dotenv/config'

import { chatRoutes } from './routes/chat.js'
import { documentRoutes } from './routes/documents.js'
import { memoryRoutes } from './routes/memory.js'
import { evalRoutes } from './routes/eval.js'
import { initDb } from './services/memoryStore.js'
import { initCollection } from './services/memoryVector.js'
import { initDocumentTables } from './services/documentStore.js'
import { initDocCollection } from './services/documentVector.js'
import { initEvalTables } from './services/evalStore.js'
```

把表初始化部分改成：

```typescript
const sqliteDb = initDb()
initDocumentTables(sqliteDb)
initEvalTables(sqliteDb)
await initCollection()
await initDocCollection()
```

把 routes 注册部分改成：

```typescript
await app.register(chatRoutes, { prefix: '/api' })
await app.register(documentRoutes, { prefix: '/api' })
await app.register(memoryRoutes, { prefix: '/api' })
await app.register(evalRoutes, { prefix: '/api' })
```

- [ ] **Step 2: 类型检查**

```bash
cd packages/server && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 启动后端，确认无错误**

```bash
cd packages/server && pnpm dev &
sleep 5 && curl -s http://localhost:3001/api/eval/test-sets && kill %1
```
Expected: `{"testSets":[]}`

- [ ] **Step 4: 提交**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): wire up eval routes and tables in entrypoint"
```

---

## Task 9: 后端端到端烟测

**Files:** （无文件改动，纯验证）

- [ ] **Step 1: 启动后端**

```bash
cd packages/server && pnpm dev
```
让它在终端 1 持续运行。

- [ ] **Step 2: 上传一个 PDF（如果数据库为空）或取一个现有 doc_id**

```bash
# 取已有文档
curl -s http://localhost:3001/api/documents
```
记录返回中的某个 `id`，下面替换 `<DOC_ID>`。

- [ ] **Step 3: 生成测试集**

```bash
curl -s -X POST http://localhost:3001/api/eval/generate \
  -H "Content-Type: application/json" \
  -d '{"docId":"<DOC_ID>"}'
```
Expected: 返回包含 `id` 和 `case_count > 0` 的 JSON。可能耗时 30-60s。记录 `id` 替换下面的 `<TS_ID>`。

- [ ] **Step 4: 查看生成的测试集**

```bash
curl -s "http://localhost:3001/api/eval/test-sets/<TS_ID>" | python3 -m json.tool | head -40
```
Expected: 看到 testSet + cases 数组，每条 case 有合理的 question/expected_answer。

- [ ] **Step 5: 跑评估**

```bash
curl -s -X POST http://localhost:3001/api/eval/runs \
  -H "Content-Type: application/json" \
  -d '{"testSetId":"<TS_ID>"}'
```
Expected: 返回 `status: "done"`、4 个 avg 字段都是 0-1 的浮点数。可能耗时 5-10分钟。

- [ ] **Step 6: 查看 run 详情**

```bash
curl -s "http://localhost:3001/api/eval/runs" | python3 -m json.tool
```
Expected: 列表中有刚才的 run，4 个 avg 字段非 null。

- [ ] **Step 7: 提交（记录烟测通过）**

如果一切正常，不需要新 commit；如果发现问题，在 worktree 内修复后用对应 task 的提交消息修复。

---

## Task 10: 前端类型 + Hook

**Files:**
- Modify: `packages/client/src/types.ts`
- Create: `packages/client/src/hooks/useEval.ts`

- [ ] **Step 1: 在 `packages/client/src/types.ts` 末尾追加**

```typescript
// === Evaluation types ===

export type EvalDifficulty = 'easy' | 'medium' | 'hard'
export type EvalRunStatus = 'running' | 'done' | 'failed'

export interface EvalTestSet {
  id: string
  doc_id: string
  name: string
  case_count: number
  created_at: string
}

export interface EvalCase {
  id: string
  test_set_id: string
  question: string
  expected_answer: string
  ground_truth_chunk_id: string
  difficulty: EvalDifficulty
}

export interface EvalRun {
  id: string
  test_set_id: string
  config_snapshot: string
  status: EvalRunStatus
  started_at: string
  finished_at: string | null
  avg_context_recall: number | null
  avg_context_precision: number | null
  avg_faithfulness: number | null
  avg_answer_relevancy: number | null
}

export interface EvalResult {
  id: string
  run_id: string
  case_id: string
  retrieved_chunk_ids: string
  generated_answer: string
  context_recall: number | null
  context_precision: number | null
  faithfulness: number | null
  answer_relevancy: number | null
  judge_reasoning: string | null
}
```

- [ ] **Step 2: 创建 `packages/client/src/hooks/useEval.ts`**

```typescript
import { useCallback, useEffect, useState } from 'react'
import type { EvalTestSet, EvalRun, EvalCase, EvalResult } from '../types'

const API = 'http://localhost:3001/api'

export interface UseEvalReturn {
  testSets: EvalTestSet[]
  runs: EvalRun[]
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  generate: (docId: string) => Promise<EvalTestSet | null>
  runEval: (testSetId: string) => Promise<EvalRun | null>
  deleteTestSet: (id: string) => Promise<void>
  fetchRunDetail: (runId: string) => Promise<{ run: EvalRun; results: EvalResult[] } | null>
  fetchTestSetDetail: (id: string) => Promise<{ testSet: EvalTestSet; cases: EvalCase[] } | null>
}

export function useEval(): UseEvalReturn {
  const [testSets, setTestSets] = useState<EvalTestSet[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [tsRes, runsRes] = await Promise.all([
        fetch(`${API}/eval/test-sets`).then(r => r.json()),
        fetch(`${API}/eval/runs`).then(r => r.json()),
      ])
      setTestSets(tsRes.testSets ?? [])
      setRuns(runsRes.runs ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const generate = useCallback(async (docId: string): Promise<EvalTestSet | null> => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API}/eval/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'failed' }))
        setError(msg ?? 'generate failed')
        return null
      }
      const ts = await res.json() as EvalTestSet
      await refresh()
      return ts
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const runEval = useCallback(async (testSetId: string): Promise<EvalRun | null> => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API}/eval/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testSetId }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'failed' }))
        setError(msg ?? 'run failed')
        return null
      }
      const run = await res.json() as EvalRun
      await refresh()
      return run
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const deleteTestSet = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`${API}/eval/test-sets/${id}`, { method: 'DELETE' })
    if (!res.ok) return
    await refresh()
  }, [refresh])

  const fetchRunDetail = useCallback(async (runId: string) => {
    const res = await fetch(`${API}/eval/runs/${runId}`)
    if (!res.ok) return null
    return res.json() as Promise<{ run: EvalRun; results: EvalResult[] }>
  }, [])

  const fetchTestSetDetail = useCallback(async (id: string) => {
    const res = await fetch(`${API}/eval/test-sets/${id}`)
    if (!res.ok) return null
    return res.json() as Promise<{ testSet: EvalTestSet; cases: EvalCase[] }>
  }, [])

  return {
    testSets, runs, busy, error,
    refresh, generate, runEval, deleteTestSet, fetchRunDetail, fetchTestSetDetail,
  }
}
```

- [ ] **Step 3: 类型检查**

```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/types.ts packages/client/src/hooks/useEval.ts
git commit -m "feat(client): add evaluation types and useEval hook"
```

---

## Task 11: 评估主面板组件

**Files:**
- Create: `packages/client/src/components/EvalPanel.tsx`
- Create: `packages/client/src/components/EvalPanel.module.css`

- [ ] **Step 1: 创建 `EvalPanel.module.css`**

```css
.container {
  padding: 12px;
  border-top: 1px solid var(--gray-200);
}

.title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--gray-700);
}

.row {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius-sm);
  font-size: 12px;
  background: white;
}

.btn {
  padding: 6px 10px;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius-sm);
  font-size: 12px;
  background: white;
  cursor: pointer;
  white-space: nowrap;
}

.btn:hover {
  background: var(--gray-50);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.primary {
  background: var(--purple);
  color: white;
  border-color: var(--purple);
}

.primary:hover {
  background: var(--purple);
  opacity: 0.9;
}

.testSetList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.testSetItem {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  background: var(--gray-50);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.testSetItemActions {
  display: flex;
  gap: 4px;
}

.runList {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.runCard {
  padding: 8px;
  background: var(--gray-50);
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
}

.runCard:hover {
  background: #eef0f4;
}

.runHeader {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: var(--gray-600);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 2px;
  font-size: 11px;
  color: var(--gray-700);
}

.error {
  color: #b91c1c;
  font-size: 11px;
  margin: 4px 0;
}

.empty {
  font-size: 11px;
  color: var(--gray-400);
  text-align: center;
  padding: 8px;
}

.badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  background: var(--gray-200);
  color: var(--gray-700);
}

.badgeDone { background: #d1fae5; color: #047857; }
.badgeFailed { background: #fee2e2; color: #b91c1c; }
.badgeRunning { background: #fef3c7; color: #92400e; }
```

- [ ] **Step 2: 创建 `EvalPanel.tsx`**

```tsx
import { useState } from 'react'
import type { Document } from '../types'
import { useEval } from '../hooks/useEval'
import { EvalRunDetail } from './EvalRunDetail'
import styles from './EvalPanel.module.css'

interface EvalPanelProps {
  documents: Document[]
}

export function EvalPanel({ documents }: EvalPanelProps): JSX.Element {
  const ev = useEval()
  const [selectedDocId, setSelectedDocId] = useState<string>('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const selectedTestSet = ev.testSets.find(ts => ts.doc_id === selectedDocId)

  const fmtMetric = (v: number | null): string =>
    v === null ? '--' : `${Math.round(v * 100)}%`

  const statusClass = (s: string): string => {
    if (s === 'done') return styles.badgeDone
    if (s === 'failed') return styles.badgeFailed
    return styles.badgeRunning
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>📊 评估</h3>

      <div className={styles.row}>
        <select
          className={styles.select}
          value={selectedDocId}
          onChange={e => setSelectedDocId(e.target.value)}
        >
          <option value="">选择文档...</option>
          {documents.map(d => (
            <option key={d.id} value={d.id}>{d.filename}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <button
          className={styles.btn}
          disabled={!selectedDocId || ev.busy}
          onClick={() => selectedDocId && ev.generate(selectedDocId)}
        >
          {ev.busy ? '处理中…' : '生成测试集'}
        </button>
        <button
          className={`${styles.btn} ${styles.primary}`}
          disabled={!selectedTestSet || ev.busy}
          onClick={() => selectedTestSet && ev.runEval(selectedTestSet.id)}
        >
          运行评估
        </button>
      </div>

      {ev.error && <div className={styles.error}>{ev.error}</div>}

      {ev.testSets.length > 0 && (
        <div className={styles.testSetList}>
          {ev.testSets.map(ts => (
            <div key={ts.id} className={styles.testSetItem}>
              <span>{ts.name} ({ts.case_count})</span>
              <div className={styles.testSetItemActions}>
                <button
                  className={styles.btn}
                  onClick={() => { void ev.deleteTestSet(ts.id) }}
                >删</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.runList}>
        {ev.runs.length === 0 && <div className={styles.empty}>暂无评估记录</div>}
        {ev.runs.map(r => (
          <div
            key={r.id}
            className={styles.runCard}
            onClick={() => r.status === 'done' && setSelectedRunId(r.id)}
          >
            <div className={styles.runHeader}>
              <span>{new Date(r.started_at).toLocaleString()}</span>
              <span className={`${styles.badge} ${statusClass(r.status)}`}>{r.status}</span>
            </div>
            <div className={styles.metrics}>
              <span>召回 {fmtMetric(r.avg_context_recall)}</span>
              <span>精确 {fmtMetric(r.avg_context_precision)}</span>
              <span>忠实 {fmtMetric(r.avg_faithfulness)}</span>
              <span>相关 {fmtMetric(r.avg_answer_relevancy)}</span>
            </div>
          </div>
        ))}
      </div>

      {selectedRunId && (
        <EvalRunDetail
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
          fetchDetail={ev.fetchRunDetail}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: 无输出（EvalRunDetail 还没创建，会报错，下一个 task 解决）

⚠️ 此步预期会有 "Cannot find module './EvalRunDetail'" 错误，先不提交，继续 Task 12。

---

## Task 12: 评估详情弹窗

**Files:**
- Create: `packages/client/src/components/EvalRunDetail.tsx`
- Create: `packages/client/src/components/EvalRunDetail.module.css`

- [ ] **Step 1: 创建 `EvalRunDetail.module.css`**

```css
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal {
  background: white;
  border-radius: 8px;
  width: min(900px, 90vw);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--gray-200);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  padding: 0 8px;
  color: var(--gray-500);
}

.body {
  padding: 14px 16px;
  overflow-y: auto;
}

.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}

.summaryCard {
  padding: 8px;
  background: var(--gray-50);
  border-radius: 4px;
  text-align: center;
}

.summaryLabel {
  font-size: 11px;
  color: var(--gray-500);
}

.summaryValue {
  font-size: 18px;
  font-weight: 600;
  color: var(--gray-800);
}

.caseList {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.caseItem {
  padding: 10px;
  border: 1px solid var(--gray-200);
  border-radius: 6px;
  font-size: 12px;
}

.caseField {
  margin-bottom: 6px;
}

.caseLabel {
  color: var(--gray-500);
  font-weight: 500;
}

.caseScores {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
}

.score {
  padding: 2px 6px;
  background: var(--gray-100);
  border-radius: 3px;
}

.scoreGood { background: #d1fae5; color: #047857; }
.scoreBad { background: #fee2e2; color: #b91c1c; }

.reasoning {
  margin-top: 6px;
  padding: 6px;
  background: #fffaeb;
  border-radius: 3px;
  font-size: 11px;
  color: var(--gray-700);
  white-space: pre-wrap;
}
```

- [ ] **Step 2: 创建 `EvalRunDetail.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { EvalRun, EvalResult } from '../types'
import styles from './EvalRunDetail.module.css'

interface EvalRunDetailProps {
  runId: string
  onClose: () => void
  fetchDetail: (runId: string) => Promise<{ run: EvalRun; results: EvalResult[] } | null>
}

export function EvalRunDetail({ runId, onClose, fetchDetail }: EvalRunDetailProps): JSX.Element {
  const [data, setData] = useState<{ run: EvalRun; results: EvalResult[] } | null>(null)

  useEffect(() => {
    void fetchDetail(runId).then(setData)
  }, [runId, fetchDetail])

  const fmtPct = (v: number | null): string =>
    v === null ? '--' : `${Math.round(v * 100)}%`

  const scoreClass = (v: number | null): string => {
    if (v === null) return styles.score
    if (v >= 0.7) return `${styles.score} ${styles.scoreGood}`
    if (v < 0.4) return `${styles.score} ${styles.scoreBad}`
    return styles.score
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>评估详情 · {runId.slice(0, 16)}</h3>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          {!data && <div>加载中...</div>}
          {data && (
            <>
              <div className={styles.summary}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>召回</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_context_recall)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>精确</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_context_precision)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>忠实</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_faithfulness)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>相关</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_answer_relevancy)}</div>
                </div>
              </div>

              <div className={styles.caseList}>
                {data.results.map(r => {
                  let reasoning: Record<string, string> = {}
                  try { reasoning = JSON.parse(r.judge_reasoning ?? '{}') } catch { /* ignore */ }
                  let retrievedIds: string[] = []
                  try { retrievedIds = JSON.parse(r.retrieved_chunk_ids) } catch { /* ignore */ }

                  return (
                    <div key={r.id} className={styles.caseItem}>
                      <div className={styles.caseField}>
                        <span className={styles.caseLabel}>检索块:</span> {retrievedIds.join(', ')}
                      </div>
                      <div className={styles.caseField}>
                        <span className={styles.caseLabel}>回答:</span> {r.generated_answer}
                      </div>
                      <div className={styles.caseScores}>
                        <span className={scoreClass(r.context_recall)}>召回 {fmtPct(r.context_recall)}</span>
                        <span className={scoreClass(r.context_precision)}>精确 {fmtPct(r.context_precision)}</span>
                        <span className={scoreClass(r.faithfulness)}>忠实 {fmtPct(r.faithfulness)}</span>
                        <span className={scoreClass(r.answer_relevancy)}>相关 {fmtPct(r.answer_relevancy)}</span>
                      </div>
                      {Object.entries(reasoning).length > 0 && (
                        <div className={styles.reasoning}>
                          {Object.entries(reasoning).map(([k, v]) => `${k}: ${v}`).join('\n')}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: 无输出（Task 11 + Task 12 一起编译通过）

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/EvalPanel.tsx \
        packages/client/src/components/EvalPanel.module.css \
        packages/client/src/components/EvalRunDetail.tsx \
        packages/client/src/components/EvalRunDetail.module.css
git commit -m "feat(client): add EvalPanel and EvalRunDetail components"
```

---

## Task 13: 把 EvalPanel 接入 App

**Files:**
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: 读取当前 `App.tsx`**

```bash
cat /Users/lee/myCode/docmind/.claude/worktrees/rag-evaluation/packages/client/src/App.tsx
```

在 imports 部分加：

```typescript
import { EvalPanel } from './components/EvalPanel'
```

在侧边栏布局里 `<MemoryPanel ... />` 之后（或合适位置），加：

```tsx
<EvalPanel documents={docs.documents} />
```

具体位置取决于现有 App.tsx 结构。在 sidebar 列表的最末尾加即可。

- [ ] **Step 2: 类型检查 + 构建**

```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: 无输出

- [ ] **Step 3: 启动前端检查 UI**

```bash
cd packages/client && pnpm dev
```
打开浏览器，确认侧边栏出现"📊 评估"区域。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(client): integrate EvalPanel into App sidebar"
```

---

## Task 14: 端到端联调

**Files:** （无文件改动）

- [ ] **Step 1: 同时启动前后端**

```bash
# 终端 1
cd packages/server && pnpm dev
# 终端 2
cd packages/client && pnpm dev
```

- [ ] **Step 2: 在浏览器中操作**

1. 在评估面板选一个已上传的 PDF
2. 点击"生成测试集" → 等 30-60s → 看到测试集出现
3. 点击"运行评估" → 等几分钟 → 看到 run 出现在历史里
4. 点击 run 卡片 → 弹窗显示详情
5. 删除测试集，确认 UI 同步刷新

- [ ] **Step 3: 排查 + 修复**

如果有问题，定位具体 task 进行修复并 commit。

- [ ] **Step 4: 联调通过后**

不需要新 commit；如果有修复，每个修复都单独 commit。

---

## Self-Review Notes

- ✅ 覆盖 spec 中所有数据表和 API
- ✅ Generator/Runner/Judge 三个核心模块都有独立 task
- ✅ 前端面板 + 详情都有
- ✅ 启动入口接入了
- ✅ 端到端烟测有专门 task
- ✅ 类型一致：`EvalRunStatus`、`EvalDifficulty` 在前后端 types 都有
- ✅ 没有占位符；所有代码都是完整可运行的
- ✅ 字段名前后一致：`avg_context_recall` 等四个指标命名统一
