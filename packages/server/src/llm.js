/**
 * Unified LLM adapter — supports Anthropic and Zhipu AI (OpenAI-compatible)
 *
 * Provider selection (in order of precedence):
 *   1. LLM_PROVIDER env var: "anthropic" | "zhipu"
 *   2. Auto-detect: ANTHROPIC_API_KEY → anthropic, ZHIPU_API_KEY → zhipu
 */

function detectProvider() {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase()
  if (explicit === 'anthropic' || explicit === 'zhipu') return explicit
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.ZHIPU_API_KEY) return 'zhipu'
  throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY or ZHIPU_API_KEY in .env')
}

const PROVIDER = detectProvider()

// ── Anthropic ──────────────────────────────────────────────────────────────
async function* streamAnthropic({ messages, system, maxTokens }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const stream = await client.messages.stream({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system,
    messages,
  })

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      yield chunk.delta.text
    }
  }
}

// ── Zhipu AI (OpenAI-compatible) ───────────────────────────────────────────
async function* streamZhipu({ messages, system, maxTokens }) {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  })

  const allMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages

  const stream = await client.chat.completions.create({
    model: process.env.ZHIPU_MODEL || 'glm-4-flash',
    max_tokens: maxTokens,
    stream: true,
    messages: allMessages,
  })

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content
    if (text) yield text
  }
}

// ── Unified API ────────────────────────────────────────────────────────────
/**
 * Stream LLM response tokens.
 * @param {object} opts
 * @param {{ role: string, content: string }[]} opts.messages
 * @param {string} [opts.system]
 * @param {number} [opts.maxTokens]
 * @returns {AsyncGenerator<string>}
 */
export function streamChat({ messages, system, maxTokens = 2048 }) {
  if (PROVIDER === 'anthropic') return streamAnthropic({ messages, system, maxTokens })
  if (PROVIDER === 'zhipu') return streamZhipu({ messages, system, maxTokens })
  throw new Error(`Unknown provider: ${PROVIDER}`)
}

export { PROVIDER }
