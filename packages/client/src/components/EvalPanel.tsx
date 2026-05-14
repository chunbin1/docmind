import { useState } from 'react'
import type { Document } from '../types'
import { useEval } from '../hooks/useEval'
import { EvalRunDetail } from './EvalRunDetail'
import styles from './EvalPanel.module.css'

interface EvalPanelProps {
  documents: Document[]
}

export function EvalPanel({ documents }: EvalPanelProps) {
  const ev = useEval()
  const [selectedDocId, setSelectedDocId] = useState<string>('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const selectedTestSet = ev.testSets.find(ts => ts.doc_id === selectedDocId)

  const fmtMetric = (v: number | null): string =>
    v === null ? '--' : `${Math.round(v * 100)}%`

  const statusClass = (s: string): string => {
    if (s === 'done') return styles.badgeDone
    if (s === 'failed') return styles.badgeFailed
    return styles.badgeRunning
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>📊 评估</h3>

      <div className={styles.row}>
        <select
          className={styles.select}
          value={selectedDocId}
          onChange={e => setSelectedDocId(e.target.value)}
        >
          <option value="">选择文档...</option>
          {documents.map(d => (
            <option key={d.id} value={d.id}>{d.filename}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <button
          className={styles.btn}
          disabled={!selectedDocId || ev.busy}
          onClick={() => selectedDocId && ev.generate(selectedDocId)}
        >
          {ev.busy ? '处理中…' : '生成测试集'}
        </button>
        <button
          className={`${styles.btn} ${styles.primary}`}
          disabled={!selectedTestSet || ev.busy}
          onClick={() => selectedTestSet && ev.runEval(selectedTestSet.id)}
        >
          运行评估
        </button>
      </div>

      {ev.error && <div className={styles.error}>{ev.error}</div>}

      {ev.testSets.length > 0 && (
        <div className={styles.testSetList}>
          {ev.testSets.map(ts => (
            <div key={ts.id} className={styles.testSetItem}>
              <span>{ts.name} ({ts.case_count})</span>
              <div className={styles.testSetItemActions}>
                <button
                  className={styles.btn}
                  onClick={() => { void ev.deleteTestSet(ts.id) }}
                >删</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.runList}>
        {ev.runs.length === 0 && <div className={styles.empty}>暂无评估记录</div>}
        {ev.runs.map(r => (
          <div
            key={r.id}
            className={styles.runCard}
            onClick={() => r.status === 'done' && setSelectedRunId(r.id)}
          >
            <div className={styles.runHeader}>
              <span>{new Date(r.started_at).toLocaleString()}</span>
              <span className={`${styles.badge} ${statusClass(r.status)}`}>{r.status}</span>
            </div>
            <div className={styles.metrics}>
              <span>召回 {fmtMetric(r.avg_context_recall)}</span>
              <span>精确 {fmtMetric(r.avg_context_precision)}</span>
              <span>忠实 {fmtMetric(r.avg_faithfulness)}</span>
              <span>相关 {fmtMetric(r.avg_answer_relevancy)}</span>
            </div>
          </div>
        ))}
      </div>

      {selectedRunId && (
        <EvalRunDetail
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
          fetchDetail={ev.fetchRunDetail}
        />
      )}
    </div>
  )
}
