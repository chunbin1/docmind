import { useCallback, useState } from 'react'
import type { TraceRecord, SpanRecord } from '../types'

const API = '/api'

export interface TraceDetail {
  trace: TraceRecord
  spans: SpanRecord[]
}

export interface TraceStats {
  total: number
  degradedPct: number
  byReason: Record<string, number>
}

export interface UseTracesReturn {
  traces: TraceRecord[]
  stats: TraceStats | null
  loading: boolean
  error: string | null
  fetchList: (filter?: { status?: string; limit?: number }) => Promise<void>
  fetchStats: () => Promise<void>
  fetchDetail: (id: string) => Promise<TraceDetail | null>
}

export function useTraces(): UseTracesReturn {
  const [traces, setTraces] = useState<TraceRecord[]>([])
  const [stats, setStats] = useState<TraceStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchList = useCallback(async (filter?: { status?: string; limit?: number }) => {
    setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams()
      if (filter?.status) qs.set('status', filter.status)
      if (filter?.limit) qs.set('limit', String(filter.limit))
      const res = await fetch(`${API}/traces?${qs.toString()}`)
      if (!res.ok) { setError(`加载失败 (${res.status})`); setTraces([]); return }
      const data = await res.json() as { traces: TraceRecord[] }
      setTraces(data.traces ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 概览统计。失败时静默置空，不写 error、不阻塞列表。
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/traces/stats`)
      if (!res.ok) { setStats(null); return }
      setStats(await res.json() as TraceStats)
    } catch {
      setStats(null)
    }
  }, [])

  const fetchDetail = useCallback(async (id: string): Promise<TraceDetail | null> => {
    const res = await fetch(`${API}/traces/${id}`)
    if (!res.ok) return null
    return res.json() as Promise<TraceDetail>
  }, [])

  return { traces, stats, loading, error, fetchList, fetchStats, fetchDetail }
}
