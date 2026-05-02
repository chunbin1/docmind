import { streamChat, PROVIDER } from '../llm.js'
import { addNotes, searchFts } from '../services/memoryStore.js'
import { upsertNote, semanticSearch, isVectorAvailable } from '../services/memoryVector.js'

const DEFAULT_SYSTEM = 'You are a helpful assistant. Answer concisely and clearly. Use markdown formatting when appropriate.'

function estimateTokens(text) {
  return Math.ceil((text || '').length / 3)
}

function trimHistoryByTokens(history, maxTokens = 6000) {
  const pinned = history.filter(m => m.pinned)
  const normal = history.filter(m => !m.pinned)
  const pinnedCost = pinned.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const budget = maxTokens - pinnedCost

  let used = 0, cutIndex = normal.length
  for (let i = normal.length - 1; i >= 0; i--) {
    const cost = estimateTokens(normal[i].content)
    if (used + cost > budget) { cutIndex = i + 1; break }
    used += cost
    if (i === 0) cutIndex = 0
  }
  return [...pinned, ...normal.slice(cutIndex)]
}

/**
 * Retrieve relevant memory notes for a query.
 * Tries ChromaDB semantic search first, falls back to FTS5.
 */
async function getRelevantNotes(query, topK = 3) {
  if (isVectorAvailable()) {
    const results = await semanticSearch(query, topK)
    if (results.length > 0) return results
  }
  return searchFts(query, topK)
}

/**
 * Persist extracted facts to SQLite + ChromaDB (fire-and-forget).
 */
function persistFacts(facts, source) {
  const saved = addNotes(facts, source)
  for (const note of saved) {
    upsertNote(note).catch(() => {})
  }
  return saved
}

/**
 * Parse LLM output that contains ##SUMMARY## and ##FACTS## sections.
 * Returns { summary, facts }.
 */
function parseCompactOutput(raw) {
  const summaryMatch = raw.match(/##SUMMARY##\s*([\s\S]*?)(?=##FACTS##|$)/)
  const factsMatch = raw.match(/##FACTS##\s*([\s\S]*)$/)

  const summary = summaryMatch?.[1]?.trim() || raw.trim()
  const facts = factsMatch?.[1]
    ?.split('\n')
    .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
    .filter(l => l.length > 3 && l.length <= 200)
    .slice(0, 5) ?? []

  return { summary, facts }
}

export async function chatRoutes(app) {
  app.get('/health', async () => ({ status: 'ok', provider: PROVIDER }))

  /**
   * POST /api/chat/stream
   * Body: { message: string, history?: {role, content}[], systemPrompt?: string }
   * Response: SSE stream
   *   data: {"text": "..."}   — token chunk
   *   data: {"done": true}    — stream complete
   *   data: {"error": "..."}  — error occurred
   */
  app.post('/chat/stream', async (request, reply) => {
    const { message, history = [], systemPrompt } = request.body

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'message is required' })
    }

    // Retrieve semantically relevant memory notes
    const relevantNotes = await getRelevantNotes(message)
    const memSection = relevantNotes.length
      ? `--- 相关记忆 ---\n${relevantNotes.map(n => `- ${n.content}`).join('\n')}`
      : ''

    const finalSystem = [systemPrompt || DEFAULT_SYSTEM, memSection]
      .filter(Boolean).join('\n\n')

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (payload) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const messages = [
      ...trimHistoryByTokens(history),
      { role: 'user', content: message },
    ]

    try {
      const stream = streamChat({ messages, system: finalSystem })
      for await (const text of stream) send({ text })
      send({ done: true })
    } catch (err) {
      app.log.error(err)
      send({ error: err.message || 'Unknown error' })
    } finally {
      reply.raw.end()
    }
  })

  /**
   * POST /api/chat/compact
   * Body: { messages: {role, content}[] }
   * Response: { summary: string, facts: string[] }
   *
   * Also persists extracted facts to memory store automatically.
   */
  app.post('/chat/compact', async (request, reply) => {
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages is required' })
    }

    const historyText = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n')

    let rawOutput = ''
    const stream = streamChat({
      messages: [{
        role: 'user',
        content: `请分析以下对话，完成两项任务：

1. 生成对话摘要（300字以内，保留关键信息和用户意图）
2. 提取值得长期记忆的重要事实（最多5条，每条50字以内，每行一条）

请严格按以下格式输出（不要添加其他内容）：

##SUMMARY##
[摘要内容]

##FACTS##
[事实1]
[事实2]

对话内容：
${historyText}`,
      }],
      system: '你是对话分析助手，专注提炼关键信息和重要事实。',
      maxTokens: 1024,
    })
    for await (const text of stream) rawOutput += text

    const { summary, facts } = parseCompactOutput(rawOutput)

    // Persist facts asynchronously
    if (facts.length > 0) {
      persistFacts(facts, 'compact')
    }

    return { summary, facts }
  })

  /**
   * POST /api/chat/nudge
   * Body: { messages: {role, content}[] }
   * Response: { extracted: number }
   *
   * Background endpoint: extracts important facts from recent conversation
   * and persists them to memory store. Called silently by client every N turns.
   */
  app.post('/chat/nudge', async (request, reply) => {
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages required' })
    }

    const historyText = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n')

    let rawFacts = ''
    try {
      const stream = streamChat({
        messages: [{
          role: 'user',
          content: `请从以下对话中提取值得长期记忆的重要事实（用户偏好、关键决策、重要信息），每条独立一行，最多5条，每条不超过50字。如果没有值得记住的，返回空内容。

对话：
${historyText}`,
        }],
        system: '你是记忆提取助手，只输出事实条目，不解释，不加序号。',
        maxTokens: 300,
      })
      for await (const text of stream) rawFacts += text
    } catch (err) {
      app.log.warn(`nudge LLM error: ${err.message}`)
      return { extracted: 0 }
    }

    const facts = rawFacts
      .split('\n')
      .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
      .filter(l => l.length > 3 && l.length <= 200)
      .slice(0, 5)

    if (facts.length > 0) {
      persistFacts(facts, 'nudge')
    }

    return { extracted: facts.length }
  })
}
