// packages/server/src/routes/chat.ts
import type { FastifyPluginAsync } from 'fastify'
import OpenAI from 'openai'
import { streamChat, PROVIDER } from '../llm.js'
import { addNotes, searchFts } from '../services/memoryStore.js'
import { upsertNote, semanticSearch, isVectorAvailable } from '../services/memoryVector.js'
import type { LLMMessage, MemoryNote, ParsedCompact, DocumentChunk } from '../types.js'
import { searchChunks, isDocVectorAvailable } from '../services/documentVector.js'
import { getWeather } from '../tools/weather.js'
import { logLlmRequest } from '../llmLog.js'
import { currentUser } from './auth.js'
import { canSend, incrementMessageCount, MESSAGE_LIMIT } from '../services/userStore.js'
import { runInTrace, withSpan, spanInput, spanOutput, spanMeta, markDegraded, currentTraceId, appendSpanLate } from '../services/tracing.js'

const DEFAULT_SYSTEM =
  'You are a helpful assistant. Answer concisely and clearly. Use markdown formatting when appropriate.'

// 工具定义（OpenAI function calling 格式）
const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气信息',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称，如 广州、北京、上海' },
        },
        required: ['city'],
      },
    },
  },
]

/**
 * 工具预检：询问模型是否需要调用工具，若需要则执行并返回结果字符串
 * 只对 zhipu provider 生效（OpenAI 兼容格式）
 */
async function runToolsIfNeeded(
  message: string,
  history: LLMMessage[],
): Promise<string> {
  if (PROVIDER !== 'zhipu') return ''

  const client = new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: message },
  ]

  const model = process.env.ZHIPU_MODEL ?? 'glm-4.7'
  logLlmRequest('chat/tool-preflight', { model, messages, tools: TOOLS })

  let response: OpenAI.Chat.ChatCompletion
  try {
    response = await client.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 256,
      stream: false,
    })
  } catch (err) {
    markDegraded('tool_preflight_failed', { error: err instanceof Error ? err.message : String(err) })
    return '' // 工具预检失败不影响主流程
  }

  const toolCalls = response.choices[0]?.message?.tool_calls
  if (!toolCalls?.length) return ''

  const results: string[] = []
  for (const tc of toolCalls) {
    try {
      const fn = (tc as { function?: { name: string; arguments: string } }).function
      if (!fn) continue
      const args = JSON.parse(fn.arguments) as Record<string, string>
      if (fn.name === 'get_weather') {
        const result = await getWeather(args.city ?? '')
        results.push(result)
      }
    } catch {
      // 单个工具失败跳过
    }
  }

  return results.length ? `\n\n--- 实时工具结果 ---\n${results.join('\n')}` : ''
}

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

async function getRelevantNotes(userId: string, query: string, topK = 3): Promise<MemoryNote[]> {
  if (isVectorAvailable()) {
    const results = await semanticSearch(userId, query, topK)
    if (results.length > 0) { spanMeta('path', 'vector'); spanMeta('hits', results.length); return results }
    markDegraded('memory_fts_fallback')
  } else {
    markDegraded('memory_vector_unavailable')
  }
  const fts = searchFts(userId, query, topK)
  spanMeta('path', 'fts'); spanMeta('hits', fts.length)
  return fts
}

async function getRelevantChunks(userId: string, query: string, docIds: string[]): Promise<DocumentChunk[]> {
  if (!docIds.length) return []
  if (!isDocVectorAvailable()) { markDegraded('doc_vector_unavailable'); return [] }
  // undefined maxK keeps the RAG.maxK default; userId limits retrieval to this user's chunks.
  const chunks = await searchChunks(query, docIds, undefined, userId)
  spanMeta('docIds', docIds.length); spanMeta('kept', chunks.length)
  return chunks
}

function persistFacts(userId: string, facts: string[], source: string): MemoryNote[] {
  const saved = addNotes(userId, facts, source)
  const traceId = currentTraceId()
  for (const note of saved) {
    upsertNote(userId, note).catch((err: unknown) => {
      if (traceId) {
        appendSpanLate(traceId, {
          name: 'memory_vector_write',
          status: 'degraded',
          degradedReason: 'memory_vector_write_failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      }
    })
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
  docIds?: string[]
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
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    if (!canSend(user)) {
      return reply.status(403).send({
        error: 'message_limit_reached',
        limit: MESSAGE_LIMIT,
        used: user.message_count,
      })
    }

    const { message, history = [], systemPrompt, docIds = [] } = request.body

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'message is required' })
    }

    // Count this send against the user's quota (no-op for unlimited users via canSend).
    incrementMessageCount(user.id)

    try {
      await runInTrace({ route: '/chat/stream', userId: user.id }, async () => {
        const [relevantNotes, relevantChunks, toolSection] = await Promise.all([
          withSpan('memory_retrieval', async () => {
            spanInput(message)
            const notes = await getRelevantNotes(user.id, message)
            spanOutput(notes.map(n => n.content).join('\n'))
            return notes
          }),
          withSpan('doc_retrieval', async () => {
            spanInput(message)
            const chunks = await getRelevantChunks(user.id, message, docIds)
            spanOutput(chunks.map(c => `[${c.filename}·块${c.chunk_index}] ${c.content}`).join('\n'))
            return chunks
          }),
          withSpan('tool_preflight', () => runToolsIfNeeded(message, history)),
        ])

        const finalSystem = await withSpan('prompt_assembly', async () => {
          const memSection = relevantNotes.length
            ? `--- 相关记忆 ---\n${relevantNotes.map(n => `- ${n.content}`).join('\n')}`
            : ''
          const docSection = relevantChunks.length
            ? `--- 文档参考 ---\n${relevantChunks.map(c => `[${c.filename} · 块${c.chunk_index}] ${c.content}`).join('\n')}`
            : ''
          const trimmed = trimHistoryByTokens(history)
          if (trimmed.length < history.length) {
            markDegraded('history_trimmed', { dropped: history.length - trimmed.length })
          }
          const finalSystem = [systemPrompt ?? DEFAULT_SYSTEM, memSection, docSection, toolSection]
            .filter(Boolean).join('\n\n')
          spanMeta('finalTokens', estimateTokens(finalSystem))
          return finalSystem
        })

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

        await withSpan('llm_generation', async () => {
          spanMeta('provider', PROVIDER)
          const t0 = performance.now()
          let firstAt = 0
          let out = ''
          try {
            const stream = streamChat({ messages, system: finalSystem, tag: 'chat/stream' })
            for await (const text of stream) {
              if (!firstAt) { firstAt = performance.now(); spanMeta('ttfbMs', Math.round(firstAt - t0)) }
              out += text
              send({ text })
            }
            spanOutput(out)
            spanMeta('outputTokens', estimateTokens(out))
            send({ done: true })
          } catch (err) {
            app.log.error(err)
            send({ error: err instanceof Error ? err.message : 'Unknown error' })
            throw err   // withSpan marks the span error; caught below so it doesn't reach Fastify
          } finally {
            reply.raw.end()
          }
        })
      })
    } catch {
      // LLM failure was already sent to the client via SSE and recorded in the trace.
    }
  })

  app.post<{ Body: CompactBody }>('/chat/compact', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages is required' })
    }

    return runInTrace({ route: '/chat/compact', userId: user.id }, async () => {
      const historyText = messages
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n')

      let rawOutput = ''
      await withSpan('summarize', async () => {
        const stream = streamChat({
          messages: [{ role: 'user', content: `请分析以下对话，完成两项任务：\n\n1. 生成对话摘要（300字以内，保留关键信息和用户意图）\n2. 提取值得长期记忆的重要事实（最多5条，每条50字以内，每行一条）\n\n请严格按以下格式输出（不要添加其他内容）：\n\n##SUMMARY##\n[摘要内容]\n\n##FACTS##\n[事实1]\n[事实2]\n\n对话内容：\n${historyText}` }],
          system: '你是对话分析助手，专注提炼关键信息和重要事实。',
          maxTokens: 1024,
          tag: 'chat/compact',
        })
        for await (const text of stream) rawOutput += text
        spanOutput(rawOutput)
      })

      const { summary, facts } = parseCompactOutput(rawOutput)
      await withSpan('memory_write', async () => {
        if (facts.length > 0) persistFacts(user.id, facts, 'compact')
        spanMeta('facts', facts.length)
      })
      return { summary, facts }
    })
  })

  app.post<{ Body: NudgeBody }>('/chat/nudge', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages required' })
    }

    return runInTrace({ route: '/chat/nudge', userId: user.id }, async () => {
      const historyText = messages
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n')

      let rawFacts = ''
      try {
        await withSpan('fact_extraction', async () => {
          const stream = streamChat({
            messages: [{ role: 'user', content: `请从以下对话中提取值得长期记忆的重要事实（用户偏好、关键决策、重要信息），每条独立一行，最多5条，每条不超过50字。如果没有值得记住的，返回空内容。\n\n对话：\n${historyText}` }],
            system: '你是记忆提取助手，只输出事实条目，不解释，不加序号。',
            maxTokens: 300,
            tag: 'chat/nudge',
          })
          for await (const text of stream) rawFacts += text
          spanOutput(rawFacts)
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        app.log.warn(`nudge LLM error: ${msg}`)
        return { extracted: 0 }
      }

      const facts = rawFacts.split('\n')
        .map(l => l.trim().replace(/^[-·•\d.]\s*/, ''))
        .filter(l => l.length > 3 && l.length <= 200).slice(0, 5)

      await withSpan('memory_write', async () => {
        if (facts.length > 0) persistFacts(user.id, facts, 'nudge')
        spanMeta('facts', facts.length)
      })
      return { extracted: facts.length }
    })
  })
}
