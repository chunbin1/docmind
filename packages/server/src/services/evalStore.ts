// packages/server/src/services/evalStore.ts
import type { DB } from './memoryStore.js'
import type {
  EvalTestSet,
  EvalCase,
  EvalRun,
  EvalRunStatus,
  EvalResult,
} from '../types.js'

let _db: DB | null = null

/** Add a column if it doesn't already exist (idempotent SQLite migration). */
function migrateAddColumn(db: DB, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export function initEvalTables(db: DB): void {
  _db = db
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_test_sets (
      id          TEXT PRIMARY KEY,
      doc_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      case_count  INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_cases (
      id                     TEXT PRIMARY KEY,
      test_set_id            TEXT NOT NULL,
      question               TEXT NOT NULL,
      expected_answer        TEXT NOT NULL,
      ground_truth_chunk_id  TEXT NOT NULL,
      difficulty             TEXT NOT NULL,
      FOREIGN KEY (test_set_id) REFERENCES eval_test_sets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS eval_runs (
      id                       TEXT PRIMARY KEY,
      test_set_id              TEXT NOT NULL,
      config_snapshot          TEXT NOT NULL,
      status                   TEXT NOT NULL,
      started_at               TEXT NOT NULL,
      finished_at              TEXT,
      avg_context_recall       REAL,
      avg_context_precision    REAL,
      avg_faithfulness         REAL,
      avg_answer_relevancy     REAL,
      total_tokens             INTEGER,
      FOREIGN KEY (test_set_id) REFERENCES eval_test_sets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS eval_results (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      case_id               TEXT NOT NULL,
      retrieved_chunk_ids   TEXT NOT NULL,
      generated_answer      TEXT NOT NULL,
      context_recall        REAL,
      context_precision     REAL,
      faithfulness          REAL,
      answer_relevancy      REAL,
      judge_reasoning       TEXT,
      prompt_tokens         INTEGER,
      completion_tokens     INTEGER,
      total_tokens          INTEGER,
      FOREIGN KEY (run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
    );
  `)

  // Migrate older DBs that predate token tracking (CREATE TABLE IF NOT EXISTS
  // won't add columns to an existing table). New columns default to NULL.
  migrateAddColumn(db, 'eval_runs', 'total_tokens', 'INTEGER')
  migrateAddColumn(db, 'eval_results', 'prompt_tokens', 'INTEGER')
  migrateAddColumn(db, 'eval_results', 'completion_tokens', 'INTEGER')
  migrateAddColumn(db, 'eval_results', 'total_tokens', 'INTEGER')
  // Mark any runs left in 'running' state from a previous server lifetime as failed,
  // so they don't get stuck forever (the in-process loop that owned them is gone).
  db.prepare(`
    UPDATE eval_runs
    SET status = 'failed', finished_at = ?
    WHERE status = 'running'
  `).run(new Date().toISOString())
}

function db(): DB {
  if (!_db) throw new Error('evalStore not initialized — call initEvalTables() first')
  return _db
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// === Test Sets ===

export function createTestSet(opts: {
  doc_id: string
  name: string
  case_count: number
}): EvalTestSet {
  const id = genId('ts')
  const created_at = new Date().toISOString()
  db().prepare(
    'INSERT INTO eval_test_sets (id, doc_id, name, case_count, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, opts.doc_id, opts.name, opts.case_count, created_at)
  return { id, ...opts, created_at }
}

export function getAllTestSets(): EvalTestSet[] {
  return db()
    .prepare('SELECT * FROM eval_test_sets ORDER BY created_at DESC')
    .all() as EvalTestSet[]
}

export function getTestSet(id: string): EvalTestSet | null {
  return (db().prepare('SELECT * FROM eval_test_sets WHERE id = ?').get(id) as EvalTestSet) ?? null
}

export function deleteTestSet(id: string): void {
  db().prepare('DELETE FROM eval_test_sets WHERE id = ?').run(id)
}

// === Cases ===

export function insertCases(testSetId: string, cases: Array<{
  question: string
  expected_answer: string
  ground_truth_chunk_id: string
  difficulty: 'easy' | 'medium' | 'hard'
}>): EvalCase[] {
  const stmt = db().prepare(
    'INSERT INTO eval_cases (id, test_set_id, question, expected_answer, ground_truth_chunk_id, difficulty) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertAll = db().transaction((items: typeof cases): EvalCase[] => {
    const inserted: EvalCase[] = []
    for (const c of items) {
      const id = genId('case')
      stmt.run(id, testSetId, c.question, c.expected_answer, c.ground_truth_chunk_id, c.difficulty)
      inserted.push({ id, test_set_id: testSetId, ...c })
    }
    return inserted
  })
  return insertAll(cases)
}

export function getCasesByTestSet(testSetId: string): EvalCase[] {
  return db()
    .prepare('SELECT * FROM eval_cases WHERE test_set_id = ?')
    .all(testSetId) as EvalCase[]
}

// === Runs ===

export function createRun(opts: {
  test_set_id: string
  config_snapshot: string
}): EvalRun {
  const id = genId('run')
  const started_at = new Date().toISOString()
  db().prepare(
    'INSERT INTO eval_runs (id, test_set_id, config_snapshot, status, started_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, opts.test_set_id, opts.config_snapshot, 'running', started_at)
  return {
    id,
    test_set_id: opts.test_set_id,
    config_snapshot: opts.config_snapshot,
    status: 'running',
    started_at,
    finished_at: null,
    avg_context_recall: null,
    avg_context_precision: null,
    avg_faithfulness: null,
    avg_answer_relevancy: null,
    total_tokens: null,
  }
}

export function finishRun(id: string, opts: {
  status: EvalRunStatus
  avg_context_recall: number
  avg_context_precision: number
  avg_faithfulness: number
  avg_answer_relevancy: number
  total_tokens: number
}): void {
  const finished_at = new Date().toISOString()
  db().prepare(`
    UPDATE eval_runs
    SET status = ?,
        finished_at = ?,
        avg_context_recall = ?,
        avg_context_precision = ?,
        avg_faithfulness = ?,
        avg_answer_relevancy = ?,
        total_tokens = ?
    WHERE id = ?
  `).run(
    opts.status, finished_at,
    opts.avg_context_recall, opts.avg_context_precision,
    opts.avg_faithfulness, opts.avg_answer_relevancy,
    opts.total_tokens,
    id,
  )
}

export function markRunFailed(id: string): void {
  db().prepare('UPDATE eval_runs SET status = ?, finished_at = ? WHERE id = ?')
    .run('failed', new Date().toISOString(), id)
}

export function getAllRuns(): EvalRun[] {
  return db()
    .prepare('SELECT * FROM eval_runs ORDER BY started_at DESC')
    .all() as EvalRun[]
}

export function getRun(id: string): EvalRun | null {
  return (db().prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as EvalRun) ?? null
}

// === Results ===

export function insertResult(opts: {
  run_id: string
  case_id: string
  retrieved_chunk_ids: string
  generated_answer: string
  context_recall: number
  context_precision: number
  faithfulness: number
  answer_relevancy: number
  judge_reasoning: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}): EvalResult {
  const id = genId('res')
  db().prepare(`
    INSERT INTO eval_results
    (id, run_id, case_id, retrieved_chunk_ids, generated_answer,
     context_recall, context_precision, faithfulness, answer_relevancy, judge_reasoning,
     prompt_tokens, completion_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.run_id, opts.case_id, opts.retrieved_chunk_ids, opts.generated_answer,
    opts.context_recall, opts.context_precision, opts.faithfulness, opts.answer_relevancy,
    opts.judge_reasoning,
    opts.prompt_tokens, opts.completion_tokens, opts.total_tokens,
  )
  return { id, ...opts }
}

export function getResultsByRun(runId: string): EvalResult[] {
  return db()
    .prepare('SELECT * FROM eval_results WHERE run_id = ?')
    .all(runId) as EvalResult[]
}

/** Delete a single result (used when re-running a failed case during resume). */
export function deleteResult(runId: string, caseId: string): void {
  db()
    .prepare('DELETE FROM eval_results WHERE run_id = ? AND case_id = ?')
    .run(runId, caseId)
}

/**
 * Results joined with their source case so the UI can show the question and
 * expected answer alongside the generated answer and scores.
 */
export function getResultsWithCaseByRun(
  runId: string,
): Array<EvalResult & { question: string; expected_answer: string; difficulty: string }> {
  return db()
    .prepare(`
      SELECT r.*, c.question, c.expected_answer, c.difficulty
      FROM eval_results r
      JOIN eval_cases c ON c.id = r.case_id
      WHERE r.run_id = ?
    `)
    .all(runId) as Array<
    EvalResult & { question: string; expected_answer: string; difficulty: string }
  >
}
