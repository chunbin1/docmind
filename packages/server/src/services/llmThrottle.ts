// packages/server/src/services/llmThrottle.ts
//
// Adaptive global throttle for Zhipu LLM calls (slow start).
//
// Starts with a large interval between calls so we don't slam the rate
// limit, then gradually shrinks the interval while calls keep succeeding.
// On a 429 it backs off aggressively (multiplicative increase). All eval
// LLM calls funnel through `throttledCompletion`, so spacing is enforced
// globally regardless of which call site fires.

const INITIAL_MS = 12_000 // slow start: 12s between calls
const MIN_MS = 1_500 // never go below 1.5s
const MAX_MS = 90_000 // hard ceiling on backoff
const SHRINK = 0.85 // success → interval *= 0.85 (slowly speed up)
const GROW = 2 // 429 → interval *= 2 (quickly slow down)

let intervalMs = INITIAL_MS
let lastCallAt = 0
// Serializes spacing: each acquire waits for the previous one's delay.
let chain: Promise<unknown> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('429') || /rate.?limit/i.test(msg) || msg.includes('速率限制')
}

export function currentIntervalMs(): number {
  return intervalMs
}

/** Block until the min interval since the previous call has elapsed. */
function acquireSlot(): Promise<void> {
  const run = chain.then(async () => {
    const wait = lastCallAt + intervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
  })
  chain = run.catch(() => {})
  return run
}

function reportSuccess(): void {
  const next = Math.max(MIN_MS, Math.round(intervalMs * SHRINK))
  if (next !== intervalMs) {
    intervalMs = next
    console.error(`[throttle] 成功，间隔缩小 → ${(intervalMs / 1000).toFixed(1)}s`)
  }
}

function report429(): void {
  const next = Math.min(MAX_MS, Math.round(intervalMs * GROW))
  if (next !== intervalMs) {
    intervalMs = next
    console.error(`[throttle] 429，间隔翻倍 → ${(intervalMs / 1000).toFixed(1)}s`)
  }
}

/**
 * Run an LLM call through the adaptive throttle. Waits for the pacing slot,
 * then adjusts the interval based on the outcome (shrink on success, grow on
 * 429). Non-429 errors are rethrown without changing the interval.
 */
export async function throttledCompletion<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot()
  try {
    const result = await fn()
    reportSuccess()
    return result
  } catch (err) {
    if (isRateLimit(err)) report429()
    throw err
  }
}
