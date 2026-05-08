// packages/server/src/routes/chat.ts
import type { FastifyPluginAsync } from 'fastify'
import { streamChat, PROVIDER } from '../llm.js'
import { addNotes, searchFts } from '../services/memoryStore.js'
import { upsertNote, semanticSearch, isVectorAvailable } from '../services/memoryVector.js'
import type { LLMMessage, MemoryNote, ParsedCompact } from '../types.js'

const DEFAULT_SYSTEM =
  'You are a helpful assistant. Answer concisely and clearly. Use markdown formatting when appropriate.'

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3)
}

function trimHistoryByTokens(history: LLMMessage[], maxTokens = 6000): LLMMessage[] {
  const pinned = history.filter(m => m.pinned)
  const normal = history.filter(m => !m.pinned)
  const pinnedCost = pinned.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const budget = maxTokens - pinnedCost

  let used = 0
  let cutIndex = normal.length
  for (let i = normal.length - 1; i >= 0; i--) {
    const cost = estimateTokens(normal[i].content)
    if (used + cost > budget) { cutIndex = i + 1; break }
    used += cost
    if (i === 0) cutIndex = 0
  }
  return [...pinned, ...normal.slice(cutIndex)]
}

async function getRelevantNotes(query: string, topK = 3): Promise<MemoryNote[]> {
  if (isVectorAvailable()) {
    const results = await semanticSearch(query, topK)
    if (results.length > 0) return results
  }
  return searchFts(query, topK)
}

function persistFacts(facts: string[], source: string): MemoryNote[] {
  const saved = addNotes(facts, source)
  for (const note of saved) {
    upsertNote(note).catch(() => {})
  }
  return saved
}

function parseCompactOutput(raw: string): ParsedCompact {
  const summaryMatch = raw.match(/##SUMMARY##\s*([\s\S]*?)(?=##FACTS##|$)/)
  const factsMatch = raw.match(/##FACTS##\s*([\s\S]*)$/)

  const summary = summaryMatch?.[1]?.trim() ?? raw.trim()
  const facts =
    factsMatch?.[1]
      ?.split('\n')
      .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
      .filter(l => l.length > 3 && l.length <= 200)
      .slice(0, 5) ?? []

  return { summary, facts }
}

interface StreamBody {
  message: string
  history?: LLMMessage[]
  systemPrompt?: string
}

interface CompactBody {
  messages: LLMMessage[]
}

interface NudgeBody {
  messages: LLMMessage[]
}

type SSEPayload =
  | { text: string }
  | { done: true }
  | { error: string }

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', provider: PROVIDER }))

  app.post<{ Body: StreamBody }>('/chat/stream', async (request, reply) => {
    const { message, history = [], systemPrompt } = request.body

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'message is required' })
    }

    const relevantNotes = await getRelevantNotes(message)
    const memSection = relevantNotes.length
      ? `--- 相关记忆 ---\n${relevantNotes.map(n => `- ${n.content}`).join('\n')}`
      : ''

    const finalSystem = [systemPrompt ?? DEFAULT_SYSTEM, memSection]
      .filter(Boolean)
      .join('\n\n')

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (payload: SSEPayload): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const messages: LLMMessage[] = [
      ...trimHistoryByTokens(history),
      { role: 'user', content: message },
    ]

    try {
      const stream = streamChat({ messages, system: finalSystem })
      for await (const text of stream) send({ text })
      send({ done: true })
    } catch (err) {
      app.log.error(err)
      const msg = err instanceof Error ? err.message : 'Unknown error'
      send({ error: msg })
    } finally {
      reply.raw.end()
    }
  })

  app.post<{ Body: CompactBody }>('/chat/compact', async (request, reply) => {
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
        content: `请分析以下对话，完成两项任务：\n\n1. 生成对话摘要（300字以内，保留关键信息和用户意图）\n2. 提取值得长期记忆的重要事实（最多5条，每条50字以内，每行一条）\n\n请严格按以下格式输出（不要添加其他内容）：\n\n##SUMMARY##\n[摘要内容]\n\n##FACTS##\n[事实1]\n[事实2]\n\n对话内容：\n${historyText}`,
      }],
      system: '你是对话分析助手，专注提炼关键信息和重要事实。',
      maxTokens: 1024,
    })
    for await (const text of stream) rawOutput += text

    const { summary, facts } = parseCompactOutput(rawOutput)
    if (facts.length > 0) persistFacts(facts, 'compact')

    return { summary, facts }
  })

  app.post<{ Body: NudgeBody }>('/chat/nudge', async (request, reply) => {
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
          content: `请从以下对话中提取值得长期记忆的重要事实（用户偏好、关键决策、重要信息），每条独立一行，最多5条，每条不超过50字。如果没有值得记住的，返回空内容。\n\n对话：\n${historyText}`,
        }],
        system: '你是记忆提取助手，只输出事实条目，不解释，不加序号。',
        maxTokens: 300,
      })
      for await (const text of stream) rawFacts += text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      app.log.warn(`nudge LLM error: ${msg}`)
      return { extracted: 0 }
    }

    const facts = rawFacts
      .split('\n')
      .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
      .filter(l => l.length > 3 && l.length <= 200)
      .slice(0, 5)

    if (facts.length > 0) persistFacts(facts, 'nudge')
    return { extracted: facts.length }
  })
}
