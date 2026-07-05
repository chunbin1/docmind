// Tracks in-flight chat generations so an explicit "stop" request can cancel
// them. Keyed by userId (single conversation per user). This is deliberately
// an *explicit* cancel channel — a mere client disconnect does NOT abort here,
// so the "keep generating after refresh" behavior stays intact.

const controllers = new Map<string, AbortController>()

/** Register a new in-flight generation for a user; returns its AbortController. */
export function registerGeneration(userId: string): AbortController {
  // Defensive: if a stale controller lingers, abort it before replacing.
  controllers.get(userId)?.abort()
  const ac = new AbortController()
  controllers.set(userId, ac)
  return ac
}

/** Remove a generation once it finishes — only if it's still the current one. */
export function unregisterGeneration(userId: string, ac: AbortController): void {
  if (controllers.get(userId) === ac) controllers.delete(userId)
}

/** Abort the user's in-flight generation. Returns true if one was running. */
export function abortGeneration(userId: string): boolean {
  const ac = controllers.get(userId)
  if (!ac) return false
  ac.abort()
  controllers.delete(userId)
  return true
}
