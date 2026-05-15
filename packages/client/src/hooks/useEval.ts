import { useCallback, useEffect, useState } from 'react'
import type { EvalTestSet, EvalRun, EvalCase, EvalResultWithCase } from '../types'

const API = 'http://localhost:3001/api'

export interface UseEvalReturn {
  testSets: EvalTestSet[]
  runs: EvalRun[]
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  generate: (docId: string) => Promise<EvalTestSet | null>
  runEval: (testSetId: string) => Promise<EvalRun | null>
  deleteTestSet: (id: string) => Promise<void>
  fetchRunDetail: (runId: string) => Promise<{ run: EvalRun; results: EvalResultWithCase[] } | null>
  fetchTestSetDetail: (id: string) => Promise<{ testSet: EvalTestSet; cases: EvalCase[] } | null>
}

export function useEval(): UseEvalReturn {
  const [testSets, setTestSets] = useState<EvalTestSet[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [tsRes, runsRes] = await Promise.all([
        fetch(`${API}/eval/test-sets`).then(r => r.json()),
        fetch(`${API}/eval/runs`).then(r => r.json()),
      ])
      setTestSets(tsRes.testSets ?? [])
      setRuns(runsRes.runs ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const generate = useCallback(async (docId: string): Promise<EvalTestSet | null> => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API}/eval/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'failed' }))
        setError(msg ?? 'generate failed')
        return null
      }
      const ts = await res.json() as EvalTestSet
      await refresh()
      return ts
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const runEval = useCallback(async (testSetId: string): Promise<EvalRun | null> => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API}/eval/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testSetId }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'failed' }))
        setError(msg ?? 'run failed')
        return null
      }
      const run = await res.json() as EvalRun
      await refresh()
      return run
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const deleteTestSet = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`${API}/eval/test-sets/${id}`, { method: 'DELETE' })
    if (!res.ok) return
    await refresh()
  }, [refresh])

  const fetchRunDetail = useCallback(async (runId: string) => {
    const res = await fetch(`${API}/eval/runs/${runId}`)
    if (!res.ok) return null
    return res.json() as Promise<{ run: EvalRun; results: EvalResultWithCase[] }>
  }, [])

  const fetchTestSetDetail = useCallback(async (id: string) => {
    const res = await fetch(`${API}/eval/test-sets/${id}`)
    if (!res.ok) return null
    return res.json() as Promise<{ testSet: EvalTestSet; cases: EvalCase[] }>
  }, [])

  return {
    testSets, runs, busy, error,
    refresh, generate, runEval, deleteTestSet, fetchRunDetail, fetchTestSetDetail,
  }
}
