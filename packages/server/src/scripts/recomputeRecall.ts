// One-off backfill: recompute context_recall for an existing run using the
// new content-aware logic (no LLM calls — only ChromaDB chunk content).
// Usage: tsx src/scripts/recomputeRecall.ts <runId>
import 'dotenv/config'
import { initDb } from '../services/memoryStore.js'
import { initDocCollection, getAllChunksByDoc } from '../services/documentVector.js'
import { scoreContextRecall } from '../services/evalJudge.js'

const runId = process.argv[2]
if (!runId) {
  console.error('usage: tsx src/scripts/recomputeRecall.ts <runId>')
  process.exit(1)
}

const db = initDb()
await initDocCollection()

const run = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId) as
  | { id: string; test_set_id: string }
  | undefined
if (!run) {
  console.error(`run not found: ${runId}`)
  process.exit(1)
}

const testSet = db.prepare('SELECT doc_id FROM eval_test_sets WHERE id = ?').get(run.test_set_id) as
  | { doc_id: string }
  | undefined
if (!testSet) {
  console.error('test set not found')
  process.exit(1)
}

// Build chunk_id -> content map once
const chunks = await getAllChunksByDoc(testSet.doc_id)
const contentById = new Map(chunks.map(ch => [ch.id, ch.content]))

const results = db
  .prepare(
    `SELECT r.id, r.case_id, r.retrieved_chunk_ids, r.context_recall AS old_recall,
            c.ground_truth_chunk_id, c.expected_answer
     FROM eval_results r JOIN eval_cases c ON c.id = r.case_id
     WHERE r.run_id = ?`,
  )
  .all(runId) as Array<{
  id: string
  case_id: string
  retrieved_chunk_ids: string
  old_recall: number
  ground_truth_chunk_id: string
  expected_answer: string
}>

const update = db.prepare('UPDATE eval_results SET context_recall = ? WHERE id = ?')
let changed = 0
let total = 0
let sum = 0

const tx = db.transaction(() => {
  for (const r of results) {
    let retrievedIds: string[] = []
    try {
      retrievedIds = JSON.parse(r.retrieved_chunk_ids)
    } catch {
      /* ignore */
    }
    const retrievedContents = retrievedIds
      .map(id => contentById.get(id) ?? '')
      .filter(Boolean)
    const newRecall = scoreContextRecall(
      retrievedIds,
      r.ground_truth_chunk_id,
      r.expected_answer,
      retrievedContents,
    )
    if (newRecall !== r.old_recall) {
      update.run(newRecall, r.id)
      changed++
    }
    sum += newRecall
    total++
  }
})
tx()

const avg = total > 0 ? sum / total : 0
db.prepare('UPDATE eval_runs SET avg_context_recall = ? WHERE id = ?').run(avg, runId)

console.log(`recomputed ${total} results, changed ${changed}`)
console.log(`new avg_context_recall = ${(avg * 100).toFixed(2)}%`)
process.exit(0)
