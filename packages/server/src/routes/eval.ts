// packages/server/src/routes/eval.ts
import type { FastifyPluginAsync } from 'fastify'
import {
  getAllTestSets,
  getTestSet,
  deleteTestSet,
  getCasesByTestSet,
  getAllRuns,
  getRun,
  getResultsByRun,
} from '../services/evalStore.js'
import { generateTestSet } from '../services/evalGenerator.js'
import { runEvaluation } from '../services/evalRunner.js'

interface GenerateBody { docId: string }
interface RunBody { testSetId: string }

export const evalRoutes: FastifyPluginAsync = async (app) => {
  // 生成测试集（阻塞式，可能耗时 30s+）
  app.post<{ Body: GenerateBody }>('/eval/generate', async (req, reply) => {
    const { docId } = req.body
    if (!docId) return reply.code(400).send({ error: 'docId required' })
    try {
      const testSet = await generateTestSet(docId)
      return testSet
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 列出所有测试集
  app.get('/eval/test-sets', async () => ({
    testSets: getAllTestSets(),
  }))

  // 测试集详情（含所有 cases）
  app.get<{ Params: { id: string } }>('/eval/test-sets/:id', async (req, reply) => {
    const testSet = getTestSet(req.params.id)
    if (!testSet) return reply.code(404).send({ error: 'test set not found' })
    const cases = getCasesByTestSet(testSet.id)
    return { testSet, cases }
  })

  // 删除测试集（级联删除 cases）
  app.delete<{ Params: { id: string } }>('/eval/test-sets/:id', async (req) => {
    deleteTestSet(req.params.id)
    return { ok: true }
  })

  // 触发一次评估（阻塞式，可能耗时几分钟）
  app.post<{ Body: RunBody }>('/eval/runs', async (req, reply) => {
    const { testSetId } = req.body
    if (!testSetId) return reply.code(400).send({ error: 'testSetId required' })
    try {
      const run = await runEvaluation(testSetId)
      return run
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 列出所有运行
  app.get('/eval/runs', async () => ({
    runs: getAllRuns(),
  }))

  // 运行详情（含所有 results）
  app.get<{ Params: { id: string } }>('/eval/runs/:id', async (req, reply) => {
    const run = getRun(req.params.id)
    if (!run) return reply.code(404).send({ error: 'run not found' })
    const results = getResultsByRun(run.id)
    return { run, results }
  })
}
