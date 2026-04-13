import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import styles from './Message.module.css'

// 摘要折叠条
function SummaryBar({ content, compactedCount }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={styles.summaryBar}>
      <button className={styles.summaryToggle} onClick={() => setExpanded(v => !v)}>
        <span className={styles.summaryIcon}>⚡</span>
        已自动压缩 {compactedCount} 条早期对话
        <span className={styles.summaryChevron}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className={styles.summaryContent}>{content}</div>
      )}
    </div>
  )
}

export function Message({ role, content, isError, isStreaming, pinned, compactedCount, index, onTogglePin }) {
  if (role === 'summary') {
    return <SummaryBar content={content} compactedCount={compactedCount} />
  }

  const isAssistant = role === 'assistant'

  return (
    <div className={`${styles.wrapper} ${isAssistant ? styles.assistant : styles.user} ${pinned ? styles.pinned : ''}`}>
      <div className={styles.avatar}>
        {isAssistant ? 'AI' : '你'}
      </div>
      <div className={`${styles.bubble} ${isError ? styles.error : ''}`}>
        {isAssistant ? (
          <div className="markdown">
            <ReactMarkdown>{content || ' '}</ReactMarkdown>
            {isStreaming && <span className={styles.cursor} />}
          </div>
        ) : (
          <p>{content}</p>
        )}
        {onTogglePin && (
          <button
            className={`${styles.pinBtn} ${pinned ? styles.pinActive : ''}`}
            onClick={() => onTogglePin(index)}
            title={pinned ? '取消固定' : '固定此消息（截断时不丢弃）'}
          >
            {pinned ? '📌' : '📍'}
          </button>
        )}
      </div>
    </div>
  )
}
