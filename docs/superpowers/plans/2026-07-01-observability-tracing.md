# Observability · Request Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request-level tracing to DocMind's chat pipeline — every `/chat/stream|nudge|compact` request records a span tree (durations, truncated I/O, status) into SQLite, surfacing 8+ currently-invisible `degraded` fallback points, queryable by admins via `/api/traces`.

**Architecture:** An `AsyncLocalStorage`-based `Tracer` bound per request (zero-signature instrumentation across modules). `withSpan()` wraps each pipeline stage in `chat.ts`; deep fallback points call `markDegraded()`. Spans flush to two SQLite tables (`traces` summary + `trace_spans` detail) at request end. Tracing never breaks the request (best-effort, wrapped in try/catch).

**Tech Stack:** Fastify + TypeScript (tsx runtime, NodeNext ESM, `.js` import extensions), better-sqlite3, `node:async_hooks`, `node:test` (first tests in the repo).

**Spec:** `docs/superpowers/specs/2026-07-01-observability-tracing-design.md`

---

## File Structure

**Create:**
- `packages/server/src/services/tracing.ts` — ALS tracer core + pure helpers (`rollupStatus`, `truncate`) + `runInTrace`/`withSpan`/`markDegraded`/`spanInput`/`spanOutput`/`spanMeta`/`currentTraceId`/`appendSpanLate`
- `packages/server/src/services/tracing.test.ts` — unit tests for pure logic
- `packages/server/src/services/traceStore.ts` — SQLite persistence (shares `memory.db`)
- `packages/server/src/services/traceStore.test.ts` — round-trip + append tests
- `packages/server/src/routes/traces.ts` — `GET /api/traces`, `/:id`, `/stats` (admin-only)

**Modify:**
- `packages/server/src/routes/auth.ts` — export shared `requireUser` / `requireAdmin`
- `packages/server/src/routes/eval.ts` — use shared `requireAdmin`
- `packages/server/src/routes/chat.ts` — instrument the 3 endpoints
- `packages/server/src/services/documentVector.ts` — `markDegraded` on minK fallback + vector-unavailable
- `packages/server/src/services/llm.ts` — `markDegraded` on model fallback
- `packages/server/src/index.ts` — `initTraceTables` + register `traceRoutes`
- `packages/server/package.json` — add `test` script

Types are defined once in `tracing.ts` (`SpanStatus`, `SpanRecord`, `TraceRecord`) and imported everywhere else.

---

## Task 1: Tracing core — pure helpers (TDD)

**Files:**
- Create: `packages/server/src/services/tracing.ts`
- Test: `packages/server/src/services/tracing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/tracing.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollupStatus, truncate } from './tracing.js'

test('rollupStatus: error beats degraded beats ok', () => {
  assert.equal(rollupStatus(['ok', 'ok']), 'ok')
  assert.equal(rollupStatus(['ok', 'degraded']), 'degraded')
  assert.equal(rollupStatus(['degraded', 'error', 'ok']), 'error')
  assert.equal(rollupStatus([]), 'ok')
})

test('truncate: caps length when content enabled', () => {
  assert.equal(truncate('hello', true, 500), 'hello')
  const long = 'x'.repeat(600)
  const out = truncate(long, true, 500)
  assert.ok(out!.startsWith('x'.repeat(500)))
  assert.ok(out!.includes('截断'))
})

test('truncate: returns null when content disabled or input empty', () => {
  assert.equal(truncate('hello', false, 500), null)
  assert.equal(truncate(undefined, true, 500), null)
  assert.equal(truncate('', true, 500), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm exec tsx --test src/services/tracing.test.ts`
Expected: FAIL — cannot find module './tracing.js' / exports not defined.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/services/tracing.ts`:

```ts
// packages/server/src/services/tracing.ts
export type SpanStatus = 'ok' | 'degraded' | 'error'

/** Roll child span statuses up into one trace status: error > degraded > ok. */
export function rollupStatus(statuses: SpanStatus[]): SpanStatus {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('degraded')) return 'degraded'
  return 'ok'
}

/** Truncate content for storage. Returns null when disabled or empty. */
export function truncate(
  s: string | null | undefined,
  contentEnabled: boolean,
  max: number,
): string | null {
  if (!contentEnabled) return null
  if (!s) return null
  if (s.length <= max) return s
  return `${s.slice(0, max)}…（截断 ${s.length - max} 字）`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm exec tsx --test src/services/tracing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/tracing.ts packages/server/src/services/tracing.test.ts
git commit -m "feat(tracing): pure helpers rollupStatus + truncate with tests"
```

---

## Task 2: Tracing core — records + ALS runtime

**Files:**
- Modify: `packages/server/src/services/tracing.ts`

No new unit test here (ALS behavior is verified via integration in Task 8's smoke test). This task adds the runtime API the rest of the plan imports.

- [ ] **Step 1: Append record types + ALS runtime to `tracing.ts`**

Append to `packages/server/src/services/tracing.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

const TRACING_ENABLED = process.env.TRACING !== 'off'
const CONTENT_ENABLED = process.env.TRACE_CONTENT !== 'off'
const MAX_FIELD = 500

export interface SpanRecord {
  id: string
  trace_id: string
  parent_span_id: string | null
  name: string
  status: SpanStatus
  start_offset_ms: number
  duration_ms: number
  degraded_reason: string | null
  input: string | null
  output: string | null
  metadata: string        // JSON
  error_message: string | null
}

export interface TraceRecord {
  id: string
  route: string
  user_id: string | null
  status: SpanStatus
  duration_ms: number
  span_count: number
  degraded_count: number
  error_count: number
  started_at: string
  created_at: string
}

interface LiveSpan {
  id: string
  parentSpanId: string | null
  name: string
  status: SpanStatus
  startMs: number          // performance.now() at start
  endMs: number
  degradedReason: string | null
  input: string | null
  output: string | null
  metadata: Record<string, unknown>
  errorMessage: string | null
}

class Tracer {
  readonly id = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  readonly startMs = performance.now()
  readonly startedAt = new Date().toISOString()
  readonly spans: LiveSpan[] = []
  constructor(readonly route: string, readonly userId: string | null) {}
}

interface Ctx { tracer: Tracer; current: LiveSpan | null }

const als = new AsyncLocalStorage<Ctx>()

function genSpanId(): string {
  return `sp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

/** The current request's trace id, or null when not inside a trace. */
export function currentTraceId(): string | null {
  return als.getStore()?.tracer.id ?? null
}
```

- [ ] **Step 2: Add `runInTrace` + span build/flush to `tracing.ts`**

Append:

```ts
// tracing.ts imports traceStore lazily to avoid a hard cycle at module load.
import { saveTrace } from './traceStore.js'

/** Run `fn` inside a fresh trace; flush all spans to SQLite when it settles. */
export async function runInTrace<T>(
  meta: { route: string; userId: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!TRACING_ENABLED) return fn()
  const tracer = new Tracer(meta.route, meta.userId)
  try {
    return await als.run({ tracer, current: null }, fn)
  } finally {
    flush(tracer)
  }
}

function flush(tracer: Tracer): void {
  try {
    const spanRecords: SpanRecord[] = tracer.spans.map(s => ({
      id: s.id,
      trace_id: tracer.id,
      parent_span_id: s.parentSpanId,
      name: s.name,
      status: s.status,
      start_offset_ms: Math.round(s.startMs - tracer.startMs),
      duration_ms: Math.round(s.endMs - s.startMs),
      degraded_reason: s.degradedReason,
      input: s.input,
      output: s.output,
      metadata: JSON.stringify(s.metadata),
      error_message: s.errorMessage,
    }))
    const statuses = tracer.spans.map(s => s.status)
    const trace: TraceRecord = {
      id: tracer.id,
      route: tracer.route,
      user_id: tracer.userId,
      status: rollupStatus(statuses),
      duration_ms: Math.round(performance.now() - tracer.startMs),
      span_count: spanRecords.length,
      degraded_count: statuses.filter(s => s === 'degraded').length,
      error_count: statuses.filter(s => s === 'error').length,
      started_at: tracer.startedAt,
      created_at: new Date().toISOString(),
    }
    saveTrace(trace, spanRecords)
  } catch (err) {
    // Observability must never break the request.
    console.warn(`[tracing] flush failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

- [ ] **Step 3: Add `withSpan` + span mutators to `tracing.ts`**

Append:

```ts
/** Wrap an async operation in a span. Nested calls become child spans. */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const store = als.getStore()
  if (!TRACING_ENABLED || !store) return fn()
  const span: LiveSpan = {
    id: genSpanId(),
    parentSpanId: store.current?.id ?? null,
    name,
    status: 'ok',
    startMs: performance.now(),
    endMs: 0,
    degradedReason: null,
    input: null,
    output: null,
    metadata: {},
    errorMessage: null,
  }
  store.tracer.spans.push(span)
  try {
    return await als.run({ tracer: store.tracer, current: span }, fn)
  } catch (err) {
    span.status = 'error'
    span.errorMessage = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    span.endMs = performance.now()
  }
}

function current(): LiveSpan | null {
  return als.getStore()?.current ?? null
}

export function spanInput(text: string): void {
  const s = current(); if (s) s.input = truncate(text, CONTENT_ENABLED, MAX_FIELD)
}

export function spanOutput(text: string): void {
  const s = current(); if (s) s.output = truncate(text, CONTENT_ENABLED, MAX_FIELD)
}

export function spanMeta(key: string, value: unknown): void {
  const s = current(); if (s) s.metadata[key] = value
}

/** Flag the current span as degraded (a fallback / suboptimal path was taken). */
export function markDegraded(reason: string, meta?: Record<string, unknown>): void {
  const s = current()
  if (!s) return
  if (s.status === 'ok') s.status = 'degraded'   // don't downgrade an error
  s.degradedReason = reason
  if (meta) Object.assign(s.metadata, meta)
}
```

- [ ] **Step 4: Add `appendSpanLate` for fire-and-forget failures**

Append:

```ts
import { appendSpan } from './traceStore.js'

/**
 * Record a span for a trace that has already flushed (e.g. a fire-and-forget
 * write that failed after the response returned). `traceId` must be captured
 * via currentTraceId() before the async boundary.
 */
export function appendSpanLate(
  traceId: string,
  s: { name: string; status: SpanStatus; degradedReason?: string; errorMessage?: string; metadata?: Record<string, unknown> },
): void {
  if (!TRACING_ENABLED) return
  try {
    appendSpan({
      id: genSpanId(),
      trace_id: traceId,
      parent_span_id: null,
      name: s.name,
      status: s.status,
      start_offset_ms: 0,
      duration_ms: 0,
      degraded_reason: s.degradedReason ?? null,
      input: null,
      output: null,
      metadata: JSON.stringify(s.metadata ?? {}),
      error_message: s.errorMessage ?? null,
    })
  } catch (err) {
    console.warn(`[tracing] appendSpanLate failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

- [ ] **Step 5: Typecheck (traceStore not built yet → expect a resolution error, fixed in Task 3)**

Run: `cd packages/server && pnpm exec tsc --noEmit 2>&1 | head`
Expected: errors only about `./traceStore.js` (`saveTrace`, `appendSpan`) not existing yet. No other errors. Proceed to Task 3.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/tracing.ts
git commit -m "feat(tracing): ALS runtime — runInTrace/withSpan/markDegraded + late append"
```

---

## Task 3: Trace store — SQLite persistence (TDD)

**Files:**
- Create: `packages/server/src/services/traceStore.ts`
- Test: `packages/server/src/services/traceStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/traceStore.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  initTraceTables, saveTrace, getTrace, listTraces, appendSpan, traceStats,
} from './traceStore.js'
import type { TraceRecord, SpanRecord } from './tracing.js'

function setup() {
  const db = new Database(':memory:')
  initTraceTables(db)
  return db
}

function mkTrace(id: string, status: TraceRecord['status'] = 'ok', degraded = 0): TraceRecord {
  return {
    id, route: '/chat/stream', user_id: 'u1', status,
    duration_ms: 100, span_count: 1, degraded_count: degraded, error_count: 0,
    started_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z',
  }
}
function mkSpan(id: string, traceId: string, over: Partial<SpanRecord> = {}): SpanRecord {
  return {
    id, trace_id: traceId, parent_span_id: null, name: 'memory_retrieval',
    status: 'ok', start_offset_ms: 0, duration_ms: 10, degraded_reason: null,
    input: 'q', output: 'r', metadata: '{}', error_message: null, ...over,
  }
}

test('saveTrace + getTrace round-trips trace and spans', () => {
  const db = setup()
  saveTrace(mkTrace('tr_1'), [mkSpan('sp_1', 'tr_1'), mkSpan('sp_2', 'tr_1')])
  const got = getTrace('tr_1')
  assert.equal(got?.trace.id, 'tr_1')
  assert.equal(got?.spans.length, 2)
  assert.equal(got?.spans[0].name, 'memory_retrieval')
  db.close()
})

test('listTraces filters by status', () => {
  const db = setup()
  saveTrace(mkTrace('tr_ok', 'ok'), [])
  saveTrace(mkTrace('tr_deg', 'degraded', 1), [])
  const degraded = listTraces({ status: 'degraded', limit: 10 })
  assert.equal(degraded.length, 1)
  assert.equal(degraded[0].id, 'tr_deg')
  db.close()
})

test('appendSpan adds a late span and bumps degraded_count + status', () => {
  const db = setup()
  saveTrace(mkTrace('tr_1', 'ok', 0), [mkSpan('sp_1', 'tr_1')])
  appendSpan(mkSpan('sp_late', 'tr_1', {
    name: 'memory_vector_write', status: 'degraded', degraded_reason: 'memory_vector_write_failed',
  }))
  const got = getTrace('tr_1')
  assert.equal(got?.spans.length, 2)
  assert.equal(got?.trace.degraded_count, 1)
  assert.equal(got?.trace.status, 'degraded')
  db.close()
})

test('traceStats reports degradedPct and byReason', () => {
  const db = setup()
  saveTrace(mkTrace('tr_ok', 'ok', 0), [mkSpan('s1', 'tr_ok')])
  saveTrace(mkTrace('tr_deg', 'degraded', 1),
    [mkSpan('s2', 'tr_deg', { status: 'degraded', degraded_reason: 'memory_fts_fallback' })])
  const stats = traceStats({})
  assert.equal(stats.total, 2)
  assert.equal(stats.degradedPct, 50)
  assert.equal(stats.byReason.memory_fts_fallback, 1)
  db.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm exec tsx --test src/services/traceStore.test.ts`
Expected: FAIL — cannot find module './traceStore.js'.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/services/traceStore.ts`:

```ts
// packages/server/src/services/traceStore.ts
import type { DB } from './memoryStore.js'
import type { SpanRecord, TraceRecord } from './tracing.js'

let _db: DB | null = null

export function initTraceTables(db: DB): void {
  _db = db
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id             TEXT PRIMARY KEY,
      route          TEXT NOT NULL,
      user_id        TEXT,
      status         TEXT NOT NULL,
      duration_ms    INTEGER NOT NULL,
      span_count     INTEGER NOT NULL,
      degraded_count INTEGER NOT NULL DEFAULT 0,
      error_count    INTEGER NOT NULL DEFAULT 0,
      started_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trace_spans (
      id              TEXT PRIMARY KEY,
      trace_id        TEXT NOT NULL,
      parent_span_id  TEXT,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL,
      start_offset_ms INTEGER NOT NULL,
      duration_ms     INTEGER NOT NULL,
      degraded_reason TEXT,
      input           TEXT,
      output          TEXT,
      metadata        TEXT,
      error_message   TEXT,
      FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_spans_trace   ON trace_spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
  `)
}

function db(): DB {
  if (!_db) throw new Error('traceStore not initialized — call initTraceTables() first')
  return _db
}

const insertTraceSql = `INSERT INTO traces
  (id, route, user_id, status, duration_ms, span_count, degraded_count, error_count, started_at, created_at)
  VALUES (@id, @route, @user_id, @status, @duration_ms, @span_count, @degraded_count, @error_count, @started_at, @created_at)`

const insertSpanSql = `INSERT INTO trace_spans
  (id, trace_id, parent_span_id, name, status, start_offset_ms, duration_ms, degraded_reason, input, output, metadata, error_message)
  VALUES (@id, @trace_id, @parent_span_id, @name, @status, @start_offset_ms, @duration_ms, @degraded_reason, @input, @output, @metadata, @error_message)`

export function saveTrace(trace: TraceRecord, spans: SpanRecord[]): void {
  const insTrace = db().prepare(insertTraceSql)
  const insSpan = db().prepare(insertSpanSql)
  db().transaction(() => {
    insTrace.run(trace)
    for (const s of spans) insSpan.run(s)
  })()
}

/** Insert a span onto an already-saved trace and refresh the trace summary. */
export function appendSpan(span: SpanRecord): void {
  db().transaction(() => {
    db().prepare(insertSpanSql).run(span)
    db().prepare('UPDATE traces SET span_count = span_count + 1 WHERE id = ?').run(span.trace_id)
    if (span.status === 'degraded') {
      db().prepare('UPDATE traces SET degraded_count = degraded_count + 1 WHERE id = ?').run(span.trace_id)
    }
    if (span.status === 'error') {
      db().prepare('UPDATE traces SET error_count = error_count + 1 WHERE id = ?').run(span.trace_id)
    }
    // Recompute rollup: error > degraded > ok
    db().prepare(`
      UPDATE traces SET status =
        CASE WHEN error_count > 0 THEN 'error'
             WHEN degraded_count > 0 THEN 'degraded'
             ELSE 'ok' END
      WHERE id = ?`).run(span.trace_id)
  })()
}

export function getTrace(id: string): { trace: TraceRecord; spans: SpanRecord[] } | null {
  const trace = db().prepare('SELECT * FROM traces WHERE id = ?').get(id) as TraceRecord | undefined
  if (!trace) return null
  const spans = db()
    .prepare('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY start_offset_ms ASC')
    .all(id) as SpanRecord[]
  return { trace, spans }
}

export function listTraces(f: { status?: string; route?: string; limit?: number }): TraceRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (f.status) { clauses.push('status = ?'); params.push(f.status) }
  if (f.route) { clauses.push('route = ?'); params.push(f.route) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500)
  return db()
    .prepare(`SELECT * FROM traces ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as TraceRecord[]
}

export function traceStats(f: { route?: string }): {
  total: number; degradedPct: number; byReason: Record<string, number>
} {
  const where = f.route ? 'WHERE route = ?' : ''
  const params = f.route ? [f.route] : []
  const total = (db().prepare(`SELECT COUNT(*) c FROM traces ${where}`).get(...params) as { c: number }).c
  const degraded = (db()
    .prepare(`SELECT COUNT(*) c FROM traces ${where ? where + ' AND' : 'WHERE'} degraded_count > 0`)
    .get(...params) as { c: number }).c
  const rows = db()
    .prepare(`SELECT degraded_reason r, COUNT(*) c FROM trace_spans
              WHERE status = 'degraded' AND degraded_reason IS NOT NULL GROUP BY degraded_reason`)
    .all() as { r: string; c: number }[]
  const byReason: Record<string, number> = {}
  for (const row of rows) byReason[row.r] = row.c
  return { total, degradedPct: total ? Math.round((degraded / total) * 100) : 0, byReason }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && pnpm exec tsx --test src/services/traceStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full typecheck (Task 2's dangling refs now resolve)**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/traceStore.ts packages/server/src/services/traceStore.test.ts
git commit -m "feat(tracing): SQLite trace store — save/get/list/append/stats with tests"
```

---

## Task 4: Shared admin guard

**Files:**
- Modify: `packages/server/src/routes/auth.ts`
- Modify: `packages/server/src/routes/eval.ts`

- [ ] **Step 1: Add shared guards to `auth.ts`**

In `packages/server/src/routes/auth.ts`, add these exports just after the `currentUser` function definition:

```ts
import type { FastifyReply } from 'fastify'

/** Reply 401 and return null if not logged in; otherwise return the user. */
export function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  const user = currentUser(request)
  if (!user) { void reply.code(401).send({ error: 'unauthorized' }); return null }
  return user
}

/** Reply 401/403 and return null unless logged in AND admin. */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply): User | null {
  const user = requireUser(request, reply)
  if (!user) return null
  if (user.is_admin !== 1) { void reply.code(403).send({ error: 'forbidden' }); return null }
  return user
}
```

(Note: `FastifyRequest` is already imported in auth.ts; add `FastifyReply` to the existing type import if not present.)

- [ ] **Step 2: Replace the local `requireAdmin` in `eval.ts` with the shared one**

In `packages/server/src/routes/eval.ts`:
1. Delete the local `requireAdmin` function definition (the `function requireAdmin(...) { ... }` block).
2. Change the auth import from `import { currentUser } from './auth.js'` to:

```ts
import { requireAdmin } from './auth.js'
```

3. Remove the now-unused `currentUser` and `FastifyRequest`/`User` imports if they are no longer referenced (run typecheck in Step 3 to confirm what's unused).

- [ ] **Step 3: Typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean. If it flags unused `FastifyRequest`/`FastifyReply`/`User`/`currentUser` in eval.ts, remove them from the import lines.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/auth.ts packages/server/src/routes/eval.ts
git commit -m "refactor(auth): extract shared requireUser/requireAdmin; eval reuses it"
```

---

## Task 5: Trace query API

**Files:**
- Create: `packages/server/src/routes/traces.ts`

- [ ] **Step 1: Write the route plugin**

Create `packages/server/src/routes/traces.ts`:

```ts
// packages/server/src/routes/traces.ts
import type { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from './auth.js'
import { listTraces, getTrace, traceStats } from '../services/traceStore.js'

export const traceRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { status?: string; route?: string; limit?: string } }>(
    '/traces', async (req, reply) => {
      if (!requireAdmin(req, reply)) return
      const { status, route, limit } = req.query
      return { traces: listTraces({ status, route, limit: limit ? Number(limit) : undefined }) }
    })

  app.get('/traces/stats', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const route = (req.query as { route?: string }).route
    return traceStats({ route })
  })

  app.get<{ Params: { id: string } }>('/traces/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const found = getTrace(req.params.id)
    if (!found) return reply.code(404).send({ error: 'trace not found' })
    return found
  })
}
```

Note: register `/traces/stats` before `/traces/:id` so `stats` is not captured as an `:id`.

- [ ] **Step 2: Typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/traces.ts
git commit -m "feat(tracing): admin-only GET /api/traces list/detail/stats"
```

---

## Task 6: Wire into server startup

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add imports**

In `packages/server/src/index.ts`, alongside the other route/service imports, add:

```ts
import { traceRoutes } from './routes/traces.js'
import { initTraceTables } from './services/traceStore.js'
```

- [ ] **Step 2: Init the tables + register the routes**

After the existing `initUserTables(sqliteDb)` line add:

```ts
initTraceTables(sqliteDb)
```

After the existing `await app.register(evalRoutes, { prefix: '/api' })` line add:

```ts
await app.register(traceRoutes, { prefix: '/api' })
```

- [ ] **Step 3: Typecheck + boot smoke**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean.

Run (boot with tracing disabled DB in a temp cwd is unnecessary — just verify it starts):
`cd packages/server && ANTHROPIC_API_KEY=placeholder DISABLE_EMBEDDING=true TRACING=on PORT=3021 timeout 5 pnpm exec tsx src/index.ts 2>&1 | grep -i "listening\|error" | head`
Expected: a "Server listening" line, no tracing-related errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(tracing): init trace tables + register trace routes"
```

---

## Task 7: Instrument `/chat/stream`

**Files:**
- Modify: `packages/server/src/routes/chat.ts`

- [ ] **Step 1: Add tracing imports**

In `packages/server/src/routes/chat.ts`, add:

```ts
import { runInTrace, withSpan, spanInput, spanOutput, spanMeta, markDegraded, currentTraceId } from '../services/tracing.js'
```

- [ ] **Step 2: Instrument `getRelevantNotes` fallback**

Replace the existing `getRelevantNotes` function body so the FTS fallback is flagged:

```ts
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
```

- [ ] **Step 3: Instrument `getRelevantChunks` vector-unavailable**

Replace `getRelevantChunks`:

```ts
async function getRelevantChunks(userId: string, query: string, docIds: string[]): Promise<DocumentChunk[]> {
  if (!docIds.length) return []
  if (!isDocVectorAvailable()) { markDegraded('doc_vector_unavailable'); return [] }
  const chunks = await searchChunks(query, docIds, undefined, userId)
  spanMeta('docIds', docIds.length); spanMeta('kept', chunks.length)
  return chunks
}
```

- [ ] **Step 3b: Flag tool preflight failure in `runToolsIfNeeded`**

`runToolsIfNeeded` swallows its preflight error and returns `''`, so the `tool_preflight` span would never surface a problem. In `runToolsIfNeeded`, change the `catch` around the `client.chat.completions.create(...)` preflight call from `catch { return '' }` to:

```ts
  } catch (err) {
    markDegraded('tool_preflight_failed', { error: err instanceof Error ? err.message : String(err) })
    return '' // 工具预检失败不影响主流程
  }
```

- [ ] **Step 4: Wrap the `/chat/stream` handler in a trace + spans**

In the `/chat/stream` handler, after the auth/quota checks and `incrementMessageCount(user.id)`, wrap the pipeline. Replace the block from `const [relevantNotes, relevantChunks, toolSection] = await Promise.all([...])` down through the streaming `try/finally` with:

```ts
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

      const { finalSystem } = await withSpan('prompt_assembly', async () => {
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
        return { finalSystem, trimmed }
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
          throw err   // withSpan marks the span error
        } finally {
          reply.raw.end()
        }
      })
    })
```

Notes for the implementer:
- `performance.now()` is a Node global; no import needed.
- The outer handler already declared `message`, `history`, `systemPrompt`, `docIds`, `user`. Keep those.
- `trimHistoryByTokens` is called once inside `prompt_assembly` (for the degraded check) and once for `messages`; leaving both is fine — it is pure. Optionally reuse `trimmed`, but keep it simple.
- `runInTrace` returns after the stream fully completes, so the trace flushes with an accurate `llm_generation` duration.

- [ ] **Step 5: Typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean. (If `trimmed` is reported unused, prefix with `_` or drop it from the returned object.)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/chat.ts
git commit -m "feat(tracing): instrument /chat/stream pipeline spans + degraded points"
```

---

## Task 8: Deep degraded points + smoke test

**Files:**
- Modify: `packages/server/src/services/documentVector.ts`
- Modify: `packages/server/src/services/llm.ts`

- [ ] **Step 1: Flag minK fallback in `documentVector.ts`**

In `searchChunks`, at the spot where `kept` falls back to minK (currently `if (kept.length < RAG.minK) kept = candidates.slice(0, RAG.minK)`), change to:

```ts
    let kept = within.slice(0, maxK)
    if (kept.length < RAG.minK) {
      kept = candidates.slice(0, RAG.minK)
      markDegraded('doc_retrieval_minK', {
        threshold: RAG.distanceThreshold,
        topDistance: candidates[0]?.distance ?? null,
      })
    }
```

Add the import at the top of `documentVector.ts`:

```ts
import { markDegraded } from './tracing.js'
```

- [ ] **Step 2: Flag model fallback in `llm.ts`**

In `streamZhipu`, in the `catch` where it switches models, add a `markDegraded` next to the existing `console.warn`:

```ts
      if (isQuotaError(err) && hasNext) {
        console.warn(`[llm] model "${model}" quota exhausted, switching to "${models[i + 1]}"`)
        markDegraded('llm_model_fallback', { from: model, to: models[i + 1] })
        continue
      }
```

Add the import at the top of `llm.ts`:

```ts
import { markDegraded } from './tracing.js'
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 4: End-to-end smoke test (real ALS + SQLite, no external LLM)**

Create a throwaway script to prove a trace with a degraded span persists. Create `packages/server/src/services/_smoke_trace.ts`:

```ts
import Database from 'better-sqlite3'
import { initTraceTables, getTrace, listTraces } from './traceStore.js'
import { runInTrace, withSpan, markDegraded } from './tracing.js'

initTraceTables(new Database(':memory:'))

const traceId = await runInTrace({ route: '/chat/stream', userId: 'u1' }, async () => {
  await withSpan('memory_retrieval', async () => { markDegraded('memory_fts_fallback') })
  await withSpan('llm_generation', async () => { /* ok */ })
  const { currentTraceId } = await import('./tracing.js')
  return currentTraceId()
})

const list = listTraces({})
const full = getTrace(list[0].id)
console.log('trace status:', full?.trace.status, '| degraded_count:', full?.trace.degraded_count)
console.log('spans:', full?.spans.map(s => `${s.name}:${s.status}${s.degraded_reason ? '(' + s.degraded_reason + ')' : ''}`).join(', '))
console.log('traceId inside run was:', traceId)
```

Run: `cd packages/server && pnpm exec tsx src/services/_smoke_trace.ts`
Expected output:
```
trace status: degraded | degraded_count: 1
spans: memory_retrieval:degraded(memory_fts_fallback), llm_generation:ok
traceId inside run was: tr_...
```

- [ ] **Step 5: Delete the smoke script**

```bash
rm packages/server/src/services/_smoke_trace.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/documentVector.ts packages/server/src/services/llm.ts
git commit -m "feat(tracing): flag doc_retrieval_minK + llm_model_fallback as degraded"
```

> **Implementation risk (spec §15):** the `llm_model_fallback` `markDegraded` must reach the `llm_generation` span through the async generator in `streamZhipu`. Verify with a manual test that forces a quota error (e.g. a bogus first model in `ZHIPU_MODEL`). If the degraded flag does NOT attach, fall back to threading a tracer explicitly into `streamChat` — but do this only if the manual test proves ALS does not propagate.

---

## Task 9: Instrument `/chat/nudge` and `/chat/compact` + late-append writes

**Files:**
- Modify: `packages/server/src/routes/chat.ts`

- [ ] **Step 1: Late-append on fire-and-forget vector write failures**

Replace `persistFacts` so a failed vector upsert is recorded (was silently swallowed):

```ts
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
```

Add `appendSpanLate` to the tracing import line from Task 7:

```ts
import { runInTrace, withSpan, spanInput, spanOutput, spanMeta, markDegraded, currentTraceId, appendSpanLate } from '../services/tracing.js'
```

- [ ] **Step 2: Wrap `/chat/compact` in a trace**

In the `/chat/compact` handler, after the `user`/`messages` validation, wrap the LLM + persistence:

```ts
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
```

- [ ] **Step 3: Wrap `/chat/nudge` in a trace**

In the `/chat/nudge` handler, after validation, wrap:

```ts
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
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/chat.ts
git commit -m "feat(tracing): trace nudge/compact + late-append silent write failures"
```

---

## Task 10: Test script + env docs + final verification

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/.env.example`

- [ ] **Step 1: Add a `test` script**

In `packages/server/package.json`, add to `"scripts"`:

```json
    "test": "tsx --test src/services/tracing.test.ts src/services/traceStore.test.ts"
```

- [ ] **Step 2: Document the env switches**

In `packages/server/.env.example`, add near the other debug flags:

```bash
# Observability: per-request tracing into SQLite (traces / trace_spans tables),
# queryable by admins at GET /api/traces. On by default.
#   TRACING=off          — disable tracing entirely (zero overhead)
#   TRACE_CONTENT=off    — store span metadata only, no truncated message/memory text
# TRACING=off
# TRACE_CONTENT=off
```

- [ ] **Step 3: Run the full test suite**

Run: `cd packages/server && pnpm test`
Expected: PASS (7 tests total across the two files).

- [ ] **Step 4: Full typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/package.json packages/server/.env.example
git commit -m "chore(tracing): add test script + document TRACING/TRACE_CONTENT env"
```

---

## Done — Definition of Success

- `pnpm test` passes (7 tests): `rollupStatus`, `truncate`×2, store round-trip, list filter, append, stats.
- `pnpm exec tsc --noEmit` clean.
- Server boots with `TRACING=on`; `GET /api/traces` returns 401 unauthenticated, 403 for non-admin, 200 for admin.
- After a real chat, `GET /api/traces/:id` shows the 5-span tree; a chat that fell back to FTS or minK shows a `degraded` trace with the right `degraded_reason`.
- `GET /api/traces/stats` reports `degradedPct` and `byReason`.
- `TRACING=off` makes `withSpan`/`markDegraded` no-ops (no rows written).
