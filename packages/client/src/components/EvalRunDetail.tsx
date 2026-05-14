import { useEffect, useState } from 'react'
import type { EvalRun, EvalResult } from '../types'
import styles from './EvalRunDetail.module.css'

interface EvalRunDetailProps {
  runId: string
  onClose: () => void
  fetchDetail: (runId: string) => Promise<{ run: EvalRun; results: EvalResult[] } | null>
}

export function EvalRunDetail({ runId, onClose, fetchDetail }: EvalRunDetailProps) {
  const [data, setData] = useState<{ run: EvalRun; results: EvalResult[] } | null>(null)

  useEffect(() => {
    void fetchDetail(runId).then(setData)
  }, [runId, fetchDetail])

  const fmtPct = (v: number | null): string =>
    v === null ? '--' : `${Math.round(v * 100)}%`

  const scoreClass = (v: number | null): string => {
    if (v === null) return styles.score
    if (v >= 0.7) return `${styles.score} ${styles.scoreGood}`
    if (v < 0.4) return `${styles.score} ${styles.scoreBad}`
    return styles.score
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>评估详情 · {runId.slice(0, 16)}</h3>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          {!data && <div>加载中...</div>}
          {data && (
            <>
              <div className={styles.summary}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>召回</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_context_recall)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>精确</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_context_precision)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>忠实</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_faithfulness)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>相关</div>
                  <div className={styles.summaryValue}>{fmtPct(data.run.avg_answer_relevancy)}</div>
                </div>
              </div>

              <div className={styles.caseList}>
                {data.results.map(r => {
                  let reasoning: Record<string, string> = {}
                  try { reasoning = JSON.parse(r.judge_reasoning ?? '{}') } catch { /* ignore */ }
                  let retrievedIds: string[] = []
                  try { retrievedIds = JSON.parse(r.retrieved_chunk_ids) } catch { /* ignore */ }

                  return (
                    <div key={r.id} className={styles.caseItem}>
                      <div className={styles.caseField}>
                        <span className={styles.caseLabel}>检索块:</span> {retrievedIds.join(', ')}
                      </div>
                      <div className={styles.caseField}>
                        <span className={styles.caseLabel}>回答:</span> {r.generated_answer}
                      </div>
                      <div className={styles.caseScores}>
                        <span className={scoreClass(r.context_recall)}>召回 {fmtPct(r.context_recall)}</span>
                        <span className={scoreClass(r.context_precision)}>精确 {fmtPct(r.context_precision)}</span>
                        <span className={scoreClass(r.faithfulness)}>忠实 {fmtPct(r.faithfulness)}</span>
                        <span className={scoreClass(r.answer_relevancy)}>相关 {fmtPct(r.answer_relevancy)}</span>
                      </div>
                      {Object.entries(reasoning).length > 0 && (
                        <div className={styles.reasoning}>
                          {Object.entries(reasoning).map(([k, v]) => `${k}: ${v}`).join('\n')}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
