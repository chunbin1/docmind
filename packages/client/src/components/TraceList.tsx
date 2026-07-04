import type { TraceRecord, TraceStatus } from '../types'
import styles from './TraceList.module.css'

interface Props {
  traces: TraceRecord[]
  onSelect: (id: string) => void
}

const statusLabel: Record<TraceStatus, string> = {
  ok: '正常',
  degraded: '降级',
  error: '错误',
}

const badgeClass: Record<TraceStatus, string> = {
  ok: styles.badgeOk,
  degraded: styles.badgeDegraded,
  error: styles.badgeError,
}

export function TraceList({ traces, onSelect }: Props) {
  if (traces.length === 0) {
    return <div className={styles.empty}>暂无 trace 记录</div>
  }
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>状态</th><th>路由</th><th>耗时</th><th>span</th><th>降级/错误</th><th>时间</th>
        </tr>
      </thead>
      <tbody>
        {traces.map(t => (
          <tr key={t.id} className={styles.row} onClick={() => onSelect(t.id)}>
            <td><span className={`${styles.badge} ${badgeClass[t.status]}`}>{statusLabel[t.status]}</span></td>
            <td className={styles.route}>{t.route}</td>
            <td>{t.duration_ms}ms</td>
            <td>{t.span_count}</td>
            <td>{t.degraded_count}/{t.error_count}</td>
            <td className={styles.time}>{new Date(t.started_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
