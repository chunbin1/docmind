// packages/server/src/services/evalRunner.ts
import OpenAI from 'openai'
import { searchChunks } from './documentVector.js'
import {
  createRun,
  finishRun,
  markRunFailed,
  insertResult,
  deleteResult,
  getCasesByTestSet,
  getTestSet,
  getRun,
  getResultsByRun,
} from './evalStore.js'
import { scoreContextRecall, scoreLLMMetrics, ZERO_USAGE } from './evalJudge.js'
import type { TokenUsage } from './evalJudge.js'
import type { EvalRun, EvalConfigSnapshot, EvalCase } from '../types.js'

const MODEL = process.env.ZHIPU_MODEL ?? 'glm-4.7'
const EMBED_MODEL = process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3'
const JUDGE_MODEL = process.env.ZHIPU_JUDGE_MODEL ?? 'glm-4.7'
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
): Promise<{ answer: string; usage: TokenUsage }> {
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
    const u = completion.usage
    return {
      answer: completion.choices[0]?.message?.content ?? '',
      usage: {
        prompt_tokens: u?.prompt_tokens ?? 0,
        completion_tokens: u?.completion_tokens ?? 0,
        total_tokens: u?.total_tokens ?? 0,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { answer: `[generation failed: ${msg}]`, usage: ZERO_USAGE }
  }
}

/** 评估单个 case：检索 → 生成答案 → 4 指标评分 → 写入 eval_results */
async function evaluateCase(runId: string, docId: string, c: EvalCase): Promise<{
  context_recall: number
  context_precision: number
  faithfulness: number
  answer_relevancy: number
  total_tokens: number
}> {
  const retrievedChunks = await searchChunks(c.question, [docId], TOP_K)
  const retrievedIds = retrievedChunks.map(rc => `${docId}_chunk_${rc.chunk_index}`)
  const { answer, usage: genUsage } = await generateAnswer(c.question, retrievedChunks)

  const recall = scoreContextRecall(
    retrievedIds,
    c.ground_truth_chunk_id,
    c.expected_answer,
    retrievedChunks.map(rc => rc.content),
  )
  const { precision, faithfulness, relevancy, usage: judgeUsage } = await scoreLLMMetrics(
    c.question,
    retrievedChunks,
    answer,
    c.expected_answer,
  )

  // Per-case token usage = answer generation + judge call
  const prompt_tokens = genUsage.prompt_tokens + judgeUsage.prompt_tokens
  const completion_tokens = genUsage.completion_tokens + judgeUsage.completion_tokens
  const total_tokens = genUsage.total_tokens + judgeUsage.total_tokens

  insertResult({
    run_id: runId,
    case_id: c.id,
    retrieved_chunk_ids: JSON.stringify(retrievedIds),
    generated_answer: answer,
    context_recall: recall,
    context_precision: precision.score,
    faithfulness: faithfulness.score,
    answer_relevancy: relevancy.score,
    judge_reasoning: JSON.stringify({
      precision: precision.reasoning,
      faithfulness: faithfulness.reasoning,
      relevancy: relevancy.reasoning,
    }),
    prompt_tokens,
    completion_tokens,
    total_tokens,
  })

  return {
    context_recall: recall,
    context_precision: precision.score,
    faithfulness: faithfulness.score,
    answer_relevancy: relevancy.score,
    total_tokens,
  }
}

/** A result counts as "good" (skippable on resume) if no metric hit a 429/judge failure. */
function isGoodResult(judgeReasoning: string | null): boolean {
  return !!judgeReasoning && !judgeReasoning.includes('judge call failed')
}

function recomputeAndFinish(runId: string): EvalRun {
  const all = getResultsByRun(runId)
  const n = Math.max(1, all.length)
  const sum = all.reduce(
    (acc, r) => ({
      cr: acc.cr + (r.context_recall ?? 0),
      cp: acc.cp + (r.context_precision ?? 0),
      f: acc.f + (r.faithfulness ?? 0),
      ar: acc.ar + (r.answer_relevancy ?? 0),
      tok: acc.tok + (r.total_tokens ?? 0),
    }),
    { cr: 0, cp: 0, f: 0, ar: 0, tok: 0 },
  )
  finishRun(runId, {
    status: 'done',
    avg_context_recall: sum.cr / n,
    avg_context_precision: sum.cp / n,
    avg_faithfulness: sum.f / n,
    avg_answer_relevancy: sum.ar / n,
    total_tokens: sum.tok,
  })
  return getRun(runId) as EvalRun
}

/**
 * 续跑：保留已成功的 case，只重跑失败（429）或从未评过的 case。
 * 用于上次因限流中断的 run 恢复。
 */
export async function resumeEvaluation(runId: string): Promise<EvalRun> {
  const run = getRun(runId)
  if (!run) throw new Error(`run not found: ${runId}`)
  const testSet = getTestSet(run.test_set_id)
  if (!testSet) throw new Error(`test set not found: ${run.test_set_id}`)

  const cases = getCasesByTestSet(run.test_set_id)
  const existing = new Map(getResultsByRun(runId).map(r => [r.case_id, r]))

  let kept = 0
  let done = 0
  console.error(`[resume] run ${runId}: ${cases.length} cases total`)
  try {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const prev = existing.get(c.id)
      if (prev && isGoodResult(prev.judge_reasoning)) {
        kept++
        continue // 保留好结果
      }
      if (prev) deleteResult(runId, c.id) // 删掉旧的失败结果，重评
      const t0 = Date.now()
      console.error(`[resume] #${i + 1}/${cases.length} 开始评估 → ${c.question}`)
      const r = await evaluateCase(runId, testSet.doc_id, c)
      done++
      const ok = r.context_precision > 0 || r.faithfulness > 0 || r.answer_relevancy > 0
      console.error(
        `[resume] #${i + 1}/${cases.length} 完成 (跳过保留 ${kept}, 已重评 ${done}) ` +
          `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ${ok ? '✓' : '✗429假0'} ` +
          `P=${r.context_precision} F=${r.faithfulness} R=${r.answer_relevancy} ` +
          `tok=${r.total_tokens} | ${c.question}`,
      )
    }
    return recomputeAndFinish(runId)
  } catch (err) {
    markRunFailed(runId)
    throw err
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
    judgeModel: JUDGE_MODEL,
  }
  const run = createRun({
    test_set_id: testSetId,
    config_snapshot: JSON.stringify(config),
  })

  console.error(`[eval] run ${run.id}: ${cases.length} cases`)
  try {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const t0 = Date.now()
      console.error(`[eval] #${i + 1}/${cases.length} 开始评估 → ${c.question}`)
      const r = await evaluateCase(run.id, testSet.doc_id, c)
      const ok = r.context_precision > 0 || r.faithfulness > 0 || r.answer_relevancy > 0
      console.error(
        `[eval] #${i + 1}/${cases.length} 完成 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `${ok ? '✓' : '✗429假0'} P=${r.context_precision} F=${r.faithfulness} R=${r.answer_relevancy} ` +
          `tok=${r.total_tokens} | ${c.question}`,
      )
    }
    return recomputeAndFinish(run.id)
  } catch (err) {
    markRunFailed(run.id)
    throw err
  }
}
