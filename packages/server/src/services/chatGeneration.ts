import { updateMessageContent } from './chatStore.js'

export interface StreamAndPersistOpts {
  assistantId: string
  stream: AsyncIterable<string>
  /** Push one chunk to the client; may throw if the socket is already closed. */
  send: (text: string) => void
  /** When aborted (user pressed Stop), persist the partial answer as terminal. */
  signal?: AbortSignal
  /** Returns the reasoning (thinking) accumulated so far, persisted alongside content. */
  getReasoning?: () => string
}

/**
 * Consume the LLM stream to completion regardless of whether the client is
 * still connected, persisting the accumulated answer. `send()` failures (closed
 * socket) are swallowed so generation keeps running server-side. Returns the
 * full text; on stream error persists status='error' and rethrows.
 *
 * A user-initiated stop aborts `signal`, which makes the underlying SDK stream
 * throw. That is NOT an error: we persist whatever was generated so far as
 * status='done' and return normally, so the stopped answer survives a refresh.
 */
export async function streamAndPersist(opts: StreamAndPersistOpts): Promise<string> {
  let out = ''
  try {
    for await (const text of opts.stream) {
      out += text
      try { opts.send(text) } catch { /* client gone — keep generating */ }
    }
    updateMessageContent(opts.assistantId, out, 'done', opts.getReasoning?.())
    return out
  } catch (err) {
    if (opts.signal?.aborted) {
      // User stopped generation: keep the partial answer as a finished message.
      updateMessageContent(opts.assistantId, out, 'done', opts.getReasoning?.())
      return out
    }
    const msg = err instanceof Error ? err.message : String(err)
    updateMessageContent(opts.assistantId, out || `出错了：${msg}`, 'error', opts.getReasoning?.())
    throw err
  }
}
