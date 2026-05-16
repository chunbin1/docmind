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

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms / 1000}s`)
    this.name = 'TimeoutError'
  }
}

export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('429') || /rate.?limit/i.test(msg) || msg.includes('速率限制')
}

/** Retryable = rate-limit OR our own request timeout. */
export function isRetryable(err: unknown): boolean {
  return isRateLimit(err) || err instanceof TimeoutError
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

// A hung request (rate-limited but never returning / erroring) would block
// forever — the SDK's default timeout is far too long. Abort after this.
const CALL_TIMEOUT_MS = 90_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    p.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Run an LLM call through the adaptive throttle, with a hard timeout.
 *
 * - waits for the pacing slot
 * - aborts the call if it hangs past CALL_TIMEOUT_MS
 * - timeout and 429 both trigger backoff (interval grows); the caller's
 *   retry loop then retries
 * - success shrinks the interval
 */
export async function throttledCompletion<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot()
  try {
    const result = await withTimeout(fn(), CALL_TIMEOUT_MS)
    reportSuccess()
    return result
  } catch (err) {
    if (err instanceof TimeoutError) {
      console.error(`[throttle] 请求超时 ${CALL_TIMEOUT_MS / 1000}s，按限流处理并退避`)
      report429()
    } else if (isRateLimit(err)) {
      report429()
    }
    throw err
  }
}
