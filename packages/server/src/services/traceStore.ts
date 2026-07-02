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
