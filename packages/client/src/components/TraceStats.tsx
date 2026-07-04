import type { TraceStats as TraceStatsData } from '../hooks/useTraces'
import { statBars } from '../lib/statBars'
import styles from './TraceStats.module.css'

interface Props {
  stats: TraceStatsData
}

export function TraceStats({ stats }: Props) {
  const bars = statBars(stats.byReason)
  return (
    <div className={styles.container}>
      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.value}>{stats.total}</div>
          <div className={styles.label}>总 trace 数</div>
        </div>
        <div className={styles.card}>
          <div className={`${styles.value} ${styles.degraded}`}>{stats.degradedPct}%</div>
          <div className={styles.label}>降级率</div>
        </div>
      </div>

      <div className={styles.reasons}>
        <div className={styles.reasonsTitle}>降级原因</div>
        {bars.length === 0 ? (
          <div className={styles.muted}>暂无降级</div>
        ) : (
          bars.map(b => (
            <div key={b.reason} className={styles.reasonRow}>
              <span className={styles.reasonName} title={b.reason}>{b.reason}</span>
              <span className={styles.barTrack}>
                <span className={styles.barFill} style={{ width: `${b.pct}%` }} />
              </span>
              <span className={styles.reasonCount}>{b.count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
