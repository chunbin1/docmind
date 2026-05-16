// packages/server/src/services/evalJudge.ts
import OpenAI from 'openai'
import type { DocumentChunk } from '../types.js'
import { throttledCompletion, isRetryable } from './llmThrottle.js'

// Judge uses a separate (more capable) model — independent of ZHIPU_MODEL,
// so the system being evaluated can stay on a cheaper model while scoring
// stays accurate.
const MODEL = process.env.ZHIPU_JUDGE_MODEL ?? 'glm-4.7'

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })
}

export interface MetricScore {
  score: number
  reasoning: string
}

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export const ZERO_USAGE: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
}

export interface LLMMetricScores {
  precision: MetricScore
  faithfulness: MetricScore
  relevancy: MetricScore
  usage: TokenUsage
}

function clampScore(v: unknown): number {
  return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0
}

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

function pickMetric(obj: unknown, key: string): MetricScore {
  const m = (obj as Record<string, unknown> | null)?.[key] as
    | { score?: unknown; reasoning?: unknown }
    | undefined
  return {
    score: clampScore(m?.score),
    reasoning: typeof m?.reasoning === 'string' ? m.reasoning : '',
  }
}

/**
 * Parse the merged judge response: a single JSON object holding all three
 * metric verdicts. Any parse failure degrades all three to score 0 with the
 * raw text preserved for debugging.
 */
function parseMergedJSON(raw: string, usage: TokenUsage): LLMMetricScores {
  try {
    const parsed = JSON.parse(stripFences(raw))
    return {
      precision: pickMetric(parsed, 'precision'),
      faithfulness: pickMetric(parsed, 'faithfulness'),
      relevancy: pickMetric(parsed, 'relevancy'),
      usage,
    }
  } catch {
    const reason = `parse failed: ${raw.slice(0, 200)}`
    return {
      precision: { score: 0, reasoning: reason },
      faithfulness: { score: 0, reasoning: reason },
      relevancy: { score: 0, reasoning: reason },
      usage,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const MAX_RETRIES = 5

/**
 * Call the judge model once and parse the merged 3-metric response.
 * Retries with exponential backoff on rate-limit (429) errors. If it
 * ultimately fails, all three metrics degrade to 0 with the error text.
 */
async function callMergedJudge(prompt: string): Promise<LLMMetricScores> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await throttledCompletion(() =>
        getClient().chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
      )
      const raw = completion.choices[0]?.message?.content ?? ''
      const u = completion.usage
      const usage: TokenUsage = {
        prompt_tokens: u?.prompt_tokens ?? 0,
        completion_tokens: u?.completion_tokens ?? 0,
        total_tokens: u?.total_tokens ?? 0,
      }
      return parseMergedJSON(raw, usage)
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === MAX_RETRIES) break
      // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s
      const base = 2000 * Math.pow(2, attempt)
      const wait = base + Math.floor(Math.random() * 1000)
      const why = err instanceof Error ? err.message : String(err)
      console.error(
        `[judge] 调用失败(${why})，第 ${attempt + 1}/${MAX_RETRIES} 次重试，等待 ${(wait / 1000).toFixed(1)}s`,
      )
      await sleep(wait)
    }
  }
  const msg = `judge call failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  return {
    precision: { score: 0, reasoning: msg },
    faithfulness: { score: 0, reasoning: msg },
    relevancy: { score: 0, reasoning: msg },
    usage: ZERO_USAGE,
  }
}

/** Strip whitespace and punctuation, lowercase — for loose content matching. */
function normalizeForMatch(s: string): string {
  return s.replace(/[\s\p{P}]/gu, '').toLowerCase()
}

/**
 * 1. 检索召回率：规则判断。
 *
 * 命中条件（满足其一即 1 分）：
 * - 检索到的 chunk 里包含标注的 ground_truth_chunk（精确匹配 chunk id）
 * - 或：期望答案的文本实质性出现在任一检索到的 chunk 内容里
 *   （答案常分散在多个 chunk，单 chunk_id 匹配会低估召回率）
 *
 * expectedAnswer / retrievedContents 为可选 —— 不传时退化为纯 chunk_id 匹配。
 */
export function scoreContextRecall(
  retrievedChunkIds: string[],
  groundTruthChunkId: string,
  expectedAnswer?: string,
  retrievedContents?: string[],
): number {
  if (retrievedChunkIds.includes(groundTruthChunkId)) return 1
  if (expectedAnswer && retrievedContents && retrievedContents.length > 0) {
    const want = normalizeForMatch(expectedAnswer)
    // 太短的答案（如单字）做包含匹配噪音大，要求至少 4 个有效字符
    if (want.length >= 4 && retrievedContents.some(c => normalizeForMatch(c).includes(want))) {
      return 1
    }
  }
  return 0
}

/**
 * 一次 LLM 调用同时评估 精确率 / 忠实度 / 相关性。
 *
 * 相比三次独立调用：请求量降 2/3，token 省（chunk 只传一次），
 * 大幅缓解 429 限流。代价是一次失败则三个指标连带为 0。
 *
 * - 精确率 Precision：检索到的片段对回答问题是否有用
 * - 忠实度 Faithfulness：回答是否完全基于片段、无编造
 * - 相关性 Relevancy：回答是否切题、覆盖期望答案
 */
export async function scoreLLMMetrics(
  question: string,
  retrievedChunks: DocumentChunk[],
  answer: string,
  expected: string,
): Promise<LLMMetricScores> {
  // Note: we do NOT early-return when chunks are empty. Precision/faithfulness
  // will naturally score ~0 (nothing was retrieved / nothing to ground on),
  // but relevancy only depends on question/answer/expected and must still be
  // judged — zeroing it on empty retrieval would be a false negative.
  const chunksText = retrievedChunks.length
    ? retrievedChunks.map((c, i) => `[Chunk ${i + 1}]\n${c.content}`).join('\n\n')
    : '（未检索到任何片段）'

  const prompt = `你是 RAG 评估专家。请基于以下信息，从三个维度独立打分（每个维度 0-1）。

问题：${question}

期望答案：${expected}

检索到的片段：
${chunksText}

AI 回答：
${answer}

评分维度：
1. precision（检索精确率）：检索到的片段对回答问题是否有用。
   - 1.0 所有片段强相关 / 0.5 部分相关 / 0.0 都无关
2. faithfulness（答案忠实度）：AI 回答是否完全基于检索片段，无编造或外部知识。
   - 1.0 完全来自片段 / 0.5 部分来自、有合理但未明确出现的内容 / 0.0 明显编造或矛盾
3. relevancy（答案相关性）：AI 回答是否切题、是否覆盖期望答案的核心信息。
   - 1.0 完全切题且覆盖核心 / 0.5 部分切题或部分覆盖 / 0.0 答非所问

严格输出 JSON（不要任何额外文字，键名必须为英文 precision / faithfulness / relevancy）：
{
  "precision":    {"score": 0.x, "reasoning": "简短说明"},
  "faithfulness": {"score": 0.x, "reasoning": "简短说明"},
  "relevancy":    {"score": 0.x, "reasoning": "简短说明"}
}`

  return callMergedJudge(prompt)
}
