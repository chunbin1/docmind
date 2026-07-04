import { useCallback, useState } from 'react'
import type { TraceRecord, SpanRecord } from '../types'

const API = '/api'

export interface TraceDetail {
  trace: TraceRecord
  spans: SpanRecord[]
}

export interface UseTracesReturn {
  traces: TraceRecord[]
  loading: boolean
  error: string | null
  fetchList: (filter?: { status?: string; limit?: number }) => Promise<void>
  fetchDetail: (id: string) => Promise<TraceDetail | null>
}

export function useTraces(): UseTracesReturn {
  const [traces, setTraces] = useState<TraceRecord[]>([])
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

  const fetchDetail = useCallback(async (id: string): Promise<TraceDetail | null> => {
    const res = await fetch(`${API}/traces/${id}`)
    if (!res.ok) return null
    return res.json() as Promise<TraceDetail>
  }, [])

  return { traces, loading, error, fetchList, fetchDetail }
}
