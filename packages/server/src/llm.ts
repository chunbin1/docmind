// packages/server/src/llm.ts
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { LLMProvider, StreamChatOptions } from './types.js'
import { logLlmRequest } from './llmLog.js'
import { markDegraded } from './services/tracing.js'

function detectProvider(): LLMProvider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase()
  if (explicit === 'anthropic' || explicit === 'zhipu') return explicit
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.ZHIPU_API_KEY) return 'zhipu'
  throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY or ZHIPU_API_KEY in .env')
}

export const PROVIDER: LLMProvider = detectProvider()

async function* streamAnthropic({
  messages,
  system,
  maxTokens = 2048,
  signal,
  onReasoning,
}: StreamChatOptions): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const stream = await client.messages.stream(
    {
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system,
      messages: messages.map(({ role, content }) => ({ role, content })),
    },
    { signal },
  )

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      if (chunk.delta.type === 'text_delta') {
        yield chunk.delta.text
      } else if (chunk.delta.type === 'thinking_delta' && onReasoning) {
        onReasoning(chunk.delta.thinking)
      }
    }
  }
}

function getZhipuModels(): string[] {
  const raw = process.env.ZHIPU_MODEL ?? 'glm-4-flash'
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function isQuotaError(err: unknown): boolean {
  const e = err as {
    status?: number
    code?: number | string
    message?: string
    error?: { code?: number | string; message?: string }
  }
  const code = e?.status ?? e?.code ?? e?.error?.code
  const msg = (e?.message ?? e?.error?.message ?? '').toLowerCase()
  return (
    code === 429 ||
    msg.includes('quota') ||
    msg.includes('insufficient') ||
    msg.includes('billing')
  )
}

type OpenAIRole = 'system' | 'user' | 'assistant'

async function* streamZhipu({
  messages,
  system,
  maxTokens = 2048,
  signal,
  onReasoning,
}: StreamChatOptions): AsyncGenerator<string> {
  const client = new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })

  const chat: { role: OpenAIRole; content: string }[] = system
    ? [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role as OpenAIRole, content: m.content }))]
    : messages.map(m => ({ role: m.role as OpenAIRole, content: m.content }))

  const models = getZhipuModels()

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    try {
      const stream = await client.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          stream: true,
          messages: chat,
        },
        { signal },
      )

      for await (const chunk of stream) {
        // reasoning_content 是智谱在 OpenAI 兼容格式上的扩展字段，SDK 类型里没有，需断言。
        const delta = chunk.choices[0]?.delta as { content?: string; reasoning_content?: string } | undefined
        if (delta?.reasoning_content && onReasoning) onReasoning(delta.reasoning_content)
        if (delta?.content) yield delta.content
      }
      return
    } catch (err) {
      const hasNext = i < models.length - 1
      if (isQuotaError(err) && hasNext) {
        console.warn(`[llm] model "${model}" quota exhausted, switching to "${models[i + 1]}"`)
        markDegraded('llm_model_fallback', { from: model, to: models[i + 1] })
        continue
      }
      throw err
    }
  }
}

export function streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  const tag = opts.tag ?? 'chat'
  if (PROVIDER === 'anthropic') {
    logLlmRequest(tag, {
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
      system: opts.system,
      messages: opts.messages,
    })
    return streamAnthropic(opts)
  }
  if (PROVIDER === 'zhipu') {
    logLlmRequest(tag, {
      model: getZhipuModels()[0],
      system: opts.system,
      messages: opts.messages,
    })
    return streamZhipu(opts)
  }
  throw new Error(`Unknown provider: ${PROVIDER}`)
}
