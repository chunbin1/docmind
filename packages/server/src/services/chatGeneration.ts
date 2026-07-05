import { updateMessageContent } from './chatStore.js'

export interface StreamAndPersistOpts {
  assistantId: string
  stream: AsyncIterable<string>
  /** Push one chunk to the client; may throw if the socket is already closed. */
  send: (text: string) => void
}

/**
 * Consume the LLM stream to completion regardless of whether the client is
 * still connected, persisting the accumulated answer. `send()` failures (closed
 * socket) are swallowed so generation keeps running server-side. Returns the
 * full text; on stream error persists status='error' and rethrows.
 */
export async function streamAndPersist(opts: StreamAndPersistOpts): Promise<string> {
  let out = ''
  try {
    for await (const text of opts.stream) {
      out += text
      try { opts.send(text) } catch { /* client gone — keep generating */ }
    }
    updateMessageContent(opts.assistantId, out, 'done')
    return out
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateMessageContent(opts.assistantId, out || `出错了：${msg}`, 'error')
    throw err
  }
}
