// packages/server/src/routes/eval.ts
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import {
  getAllTestSets,
  getTestSet,
  deleteTestSet,
  getCasesByTestSet,
  getAllRuns,
  getRun,
  getResultsWithCaseByRun,
} from '../services/evalStore.js'
import { generateTestSet } from '../services/evalGenerator.js'
import { runEvaluation, resumeEvaluation } from '../services/evalRunner.js'
import { requireAdmin } from './auth.js'

interface GenerateBody { docId: string }
interface RunBody { testSetId: string }

// Eval uses Zhipu's OpenAI-compatible API (for generation and judging). It cannot
// fall back to Anthropic because the model + endpoint are hardcoded throughout the
// eval services. Surface a clear 503 instead of letting the OpenAI client fail
// with an unauthenticated error.
function requireZhipu(reply: FastifyReply): boolean {
  if (process.env.ZHIPU_API_KEY) return true
  void reply.code(503).send({ error: 'Eval requires ZHIPU_API_KEY' })
  return false
}


export const evalRoutes: FastifyPluginAsync = async (app) => {
  // 生成测试集（阻塞式，可能耗时 30s+）
  app.post<{ Body: GenerateBody }>('/eval/generate', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    if (!requireZhipu(reply)) return
    const { docId } = req.body
    if (!docId) return reply.code(400).send({ error: 'docId required' })
    try {
      return await generateTestSet(user.id, docId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 列出当前用户的测试集
  app.get('/eval/test-sets', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    return { testSets: getAllTestSets(user.id) }
  })

  // 测试集详情（含所有 cases）
  app.get<{ Params: { id: string } }>('/eval/test-sets/:id', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    const testSet = getTestSet(req.params.id)
    if (!testSet || testSet.user_id !== user.id) return reply.code(404).send({ error: 'test set not found' })
    const cases = getCasesByTestSet(testSet.id)
    return { testSet, cases }
  })

  // 删除测试集（级联删除 cases）
  app.delete<{ Params: { id: string } }>('/eval/test-sets/:id', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    const testSet = getTestSet(req.params.id)
    if (!testSet || testSet.user_id !== user.id) return reply.code(404).send({ error: 'test set not found' })
    deleteTestSet(testSet.id)
    return { ok: true }
  })

  // 触发一次评估（阻塞式，可能耗时几分钟）
  app.post<{ Body: RunBody }>('/eval/runs', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    if (!requireZhipu(reply)) return
    const { testSetId } = req.body
    if (!testSetId) return reply.code(400).send({ error: 'testSetId required' })
    const testSet = getTestSet(testSetId)
    if (!testSet || testSet.user_id !== user.id) return reply.code(404).send({ error: 'test set not found' })
    try {
      return await runEvaluation(testSetId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 续跑：保留已成功的 case，只重跑失败/未评的（阻塞式）
  app.post<{ Params: { id: string } }>('/eval/runs/:id/resume', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    if (!requireZhipu(reply)) return
    const run = getRun(req.params.id)
    const ts = run && getTestSet(run.test_set_id)
    if (!run || !ts || ts.user_id !== user.id) return reply.code(404).send({ error: 'run not found' })
    try {
      return await resumeEvaluation(req.params.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // 列出当前用户的运行
  app.get('/eval/runs', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    return { runs: getAllRuns(user.id) }
  })

  // 运行详情（含所有 results）
  app.get<{ Params: { id: string } }>('/eval/runs/:id', async (req, reply) => {
    const user = requireAdmin(req, reply)
    if (!user) return
    const run = getRun(req.params.id)
    const ts = run && getTestSet(run.test_set_id)
    if (!run || !ts || ts.user_id !== user.id) return reply.code(404).send({ error: 'run not found' })
    const results = getResultsWithCaseByRun(run.id)
    return { run, results }
  })
}
