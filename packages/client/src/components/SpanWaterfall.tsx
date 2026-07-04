import { useState } from 'react'
import type { SpanRecord, TraceStatus } from '../types'
import { buildWaterfall } from '../lib/waterfall'
import styles from './SpanWaterfall.module.css'

interface Props {
  spans: SpanRecord[]
  totalMs: number
}

const barClass: Record<TraceStatus, string> = {
  ok: styles.barOk,
  degraded: styles.barDegraded,
  error: styles.barError,
}

function fmtMeta(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function SpanWaterfall({ spans, totalMs }: Props) {
  const rows = buildWaterfall(spans, totalMs)
  const [selected, setSelected] = useState<string | null>(null)

  if (rows.length === 0) {
    return <div className={styles.empty}>该 trace 没有 span</div>
  }

  return (
    <div className={styles.container}>
      {rows.map(({ span, depth, leftPct, widthPct }) => (
        <div key={span.id}>
          <div
            className={styles.row}
            onClick={() => setSelected(selected === span.id ? null : span.id)}
          >
            <div className={styles.label} style={{ paddingLeft: depth * 16 + 8 }}>
              <span className={styles.name}>{span.name}</span>
              {span.status !== 'ok' && (
                <span className={styles.tag}>{span.status === 'error' ? '错误' : '降级'}</span>
              )}
            </div>
            <div className={styles.track}>
              <div
                className={`${styles.bar} ${barClass[span.status]}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                title={`${span.duration_ms}ms`}
              />
            </div>
            <div className={styles.dur}>{span.duration_ms}ms</div>
          </div>

          {selected === span.id && (
            <div className={styles.detail}>
              {span.degraded_reason && (
                <div className={styles.detailRow}><b>降级原因：</b>{span.degraded_reason}</div>
              )}
              {span.error_message && (
                <div className={styles.detailRow}><b>错误：</b>{span.error_message}</div>
              )}
              <div className={styles.detailRow}>
                <b>输入：</b>{span.input ?? <i className={styles.muted}>内容未记录</i>}
              </div>
              <div className={styles.detailRow}>
                <b>输出：</b>{span.output ?? <i className={styles.muted}>内容未记录</i>}
              </div>
              <div className={styles.detailRow}>
                <b>metadata：</b>
                <pre className={styles.pre}>{fmtMeta(span.metadata)}</pre>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
