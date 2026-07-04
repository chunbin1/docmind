import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTraces, type TraceDetail } from '../hooks/useTraces'
import { SpanWaterfall } from './SpanWaterfall'
import styles from './TraceDetailPage.module.css'

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { fetchDetail } = useTraces()
  const [detail, setDetail] = useState<TraceDetail | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    void fetchDetail(id).then(d => {
      if (d) setDetail(d)
      else setNotFound(true)
    })
  }, [id, fetchDetail])

  if (notFound) {
    return (
      <div className={styles.page}>
        <Link to="/traces" className={styles.back}>← 返回列表</Link>
        <div className={styles.empty}>trace 不存在</div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={styles.page}>
        <Link to="/traces" className={styles.back}>← 返回列表</Link>
        <div className={styles.loading}>加载中…</div>
      </div>
    )
  }

  const { trace, spans } = detail
  return (
    <div className={styles.page}>
      <Link to="/traces" className={styles.back}>← 返回列表</Link>
      <div className={styles.summary}>
        <h1 className={styles.title}>{trace.route}</h1>
        <div className={styles.meta}>
          <span>状态：{trace.status}</span>
          <span>总耗时：{trace.duration_ms}ms</span>
          <span>span：{trace.span_count}</span>
          <span>降级/错误：{trace.degraded_count}/{trace.error_count}</span>
          <span>{new Date(trace.started_at).toLocaleString()}</span>
        </div>
      </div>
      <SpanWaterfall spans={spans} totalMs={trace.duration_ms} />
    </div>
  )
}
