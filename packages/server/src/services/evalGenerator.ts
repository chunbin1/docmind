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
