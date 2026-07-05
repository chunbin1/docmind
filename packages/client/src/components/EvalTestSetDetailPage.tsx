import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useEval } from '../hooks/useEval'
import type { EvalTestSet, EvalCase } from '../types'
import styles from './EvalTestSetDetailPage.module.css'

export function EvalTestSetDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { fetchTestSetDetail } = useEval()
  const [data, setData] = useState<{ testSet: EvalTestSet; cases: EvalCase[] } | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    void fetchTestSetDetail(id).then(d => {
      if (d) setData(d)
      else setNotFound(true)
    })
  }, [id, fetchTestSetDetail])

  if (notFound) {
    return (
      <div className={styles.page}>
        <Link to="/" className={styles.back}>← 返回对话</Link>
        <div className={styles.empty}>测试集不存在</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className={styles.page}>
        <Link to="/" className={styles.back}>← 返回对话</Link>
        <div className={styles.loading}>加载中…</div>
      </div>
    )
  }

  const { testSet, cases } = data
  return (
    <div className={styles.page}>
      <Link to="/" className={styles.back}>← 返回对话</Link>
      <div className={styles.summary}>
        <h1 className={styles.title}>{testSet.name}</h1>
        <div className={styles.meta}>
          <span>题目数：{testSet.case_count}</span>
          <span>创建时间：{new Date(testSet.created_at).toLocaleString()}</span>
          <span>文档 ID：{testSet.doc_id}</span>
        </div>
      </div>

      <div className={styles.caseList}>
        {cases.map(c => (
          <div key={c.id} className={styles.caseItem}>
            <div className={styles.caseField}>
              <span className={`${styles.badge} ${styles[`badge_${c.difficulty}`]}`}>{c.difficulty}</span>
              <span className={styles.question}>{c.question}</span>
            </div>
            <div className={styles.caseField}>
              <span className={styles.label}>期望答案：</span>{c.expected_answer}
            </div>
            <div className={styles.caseField}>
              <span className={styles.label}>来源分块：</span>
              <code className={styles.mono}>{c.ground_truth_chunk_id}</code>
            </div>
            <div className={styles.caseField}>
              <span className={styles.label}>Case ID：</span>
              <code className={styles.mono}>{c.id}</code>
            </div>
          </div>
        ))}
        {cases.length === 0 && <div className={styles.empty}>该测试集没有题目</div>}
      </div>
    </div>
  )
}
