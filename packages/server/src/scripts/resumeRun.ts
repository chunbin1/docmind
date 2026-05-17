// Resume an interrupted/rate-limited eval run: keeps good results, re-runs
// only the failed (429) or never-evaluated cases.
// Usage: tsx src/scripts/resumeRun.ts <runId>
import 'dotenv/config'
import { initDb } from '../services/memoryStore.js'
import { initDocumentTables } from '../services/documentStore.js'
import { initEvalTables } from '../services/evalStore.js'
import { initDocCollection } from '../services/documentVector.js'
import { resumeEvaluation } from '../services/evalRunner.js'

const runId = process.argv[2]
if (!runId) {
  console.error('usage: tsx src/scripts/resumeRun.ts <runId>')
  process.exit(1)
}

const sqliteDb = initDb()
initDocumentTables(sqliteDb)
initEvalTables(sqliteDb)
await initDocCollection()

console.error(`[resume] resuming run ${runId} ...`)
const run = await resumeEvaluation(runId)
console.error('[resume] done:', {
  status: run.status,
  recall: run.avg_context_recall,
  precision: run.avg_context_precision,
  faithfulness: run.avg_faithfulness,
  relevancy: run.avg_answer_relevancy,
})
process.exit(0)
