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
