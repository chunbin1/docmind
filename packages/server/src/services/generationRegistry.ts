// Tracks in-flight chat generations so an explicit "stop" request can cancel
// them. Keyed by conversationId — each conversation may have at most one active
// generation, and different conversations of the same user run concurrently.
// This is deliberately an *explicit* cancel channel — a mere client disconnect
// does NOT abort here, so the "keep generating after refresh" behavior stays intact.

const controllers = new Map<string, AbortController>()

/** Register a new in-flight generation for a conversation; returns its AbortController. */
export function registerGeneration(conversationId: string): AbortController {
  // Defensive: if a stale controller lingers, abort it before replacing.
  controllers.get(conversationId)?.abort()
  const ac = new AbortController()
  controllers.set(conversationId, ac)
  return ac
}

/** Remove a generation once it finishes — only if it's still the current one. */
export function unregisterGeneration(conversationId: string, ac: AbortController): void {
  if (controllers.get(conversationId) === ac) controllers.delete(conversationId)
}

/** Abort the conversation's in-flight generation. Returns true if one was running. */
export function abortGeneration(conversationId: string): boolean {
  const ac = controllers.get(conversationId)
  if (!ac) return false
  ac.abort()
  controllers.delete(conversationId)
  return true
}
