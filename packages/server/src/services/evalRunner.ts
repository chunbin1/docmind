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
  getRun,
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
    // Re-read so the response includes finished_at and the averages
    return getRun(run.id) ?? { ...run, status: 'done' }
  } catch (err) {
    markRunFailed(run.id)
    throw err
  }
}
