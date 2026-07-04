import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTraces } from '../hooks/useTraces'
import { TraceList } from './TraceList'
import styles from './TracesPage.module.css'

export function TracesPage() {
  const { traces, loading, error, fetchList } = useTraces()
  const [status, setStatus] = useState('')
  const navigate = useNavigate()

  const load = (): void => { void fetchList({ status: status || undefined, limit: 100 }) }

  useEffect(load, [status])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.back}>← 返回对话</Link>
        <h1 className={styles.title}>🔍 Traces</h1>
        <div className={styles.controls}>
          <select
            className={styles.select}
            value={status}
            onChange={e => setStatus(e.target.value)}
          >
            <option value="">全部状态</option>
            <option value="ok">正常</option>
            <option value="degraded">降级</option>
            <option value="error">错误</option>
          </select>
          <button className={styles.btn} onClick={load}>刷新</button>
        </div>
      </header>

      {error && (
        <div className={styles.error}>
          {error}
          <button className={styles.retry} onClick={load}>重试</button>
        </div>
      )}

      {loading
        ? <div className={styles.loading}>加载中…</div>
        : <TraceList traces={traces} onSelect={id => navigate(`/traces/${id}`)} />}
    </div>
  )
}
