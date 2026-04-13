import { streamChat, PROVIDER } from '../llm.js'

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

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    })

    const send = (payload) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const messages = [
      ...trimHistoryByTokens(history),
      { role: 'user', content: message },
    ]

    try {
      const stream = streamChat({
        messages,
        system: systemPrompt || 'You are a helpful assistant. Answer concisely and clearly. Use markdown formatting when appropriate.',
      })

      for await (const text of stream) {
        send({ text })
      }

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
   * Response: { summary: string }
   */
  app.post('/chat/compact', async (request, reply) => {
    const { messages } = request.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages is required' })
    }

    const historyText = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n')

    let summary = ''
    const stream = streamChat({
      messages: [{ role: 'user', content: `请将以下对话压缩为简洁摘要，保留关键信息、用户意图和重要结论（300字以内）：\n\n${historyText}` }],
      system: '你是对话摘要助手，专注提炼关键信息。',
    })
    for await (const text of stream) summary += text

    return { summary }
  })
}
