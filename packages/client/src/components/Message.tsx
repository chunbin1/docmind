import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { MessageRole } from '../types'
import styles from './Message.module.css'

interface SummaryBarProps {
  content: string
  compactedCount: number
}

function SummaryBar({ content, compactedCount }: SummaryBarProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={styles.summaryBar}>
      <button
        className={styles.summaryToggle}
        onClick={() => setExpanded(v => !v)}
      >
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

interface MessageProps {
  role: MessageRole
  content: string
  isError?: boolean
  isStreaming?: boolean
  pinned?: boolean
  compactedCount?: number
  index: number
  onTogglePin?: (index: number) => void
}

export function Message({
  role,
  content,
  isError,
  isStreaming,
  pinned,
  compactedCount,
  index,
  onTogglePin,
}: MessageProps) {
  if (role === 'summary') {
    return <SummaryBar content={content} compactedCount={compactedCount ?? 0} />
  }

  const isAssistant = role === 'assistant'

  return (
    <div
      className={[
        styles.wrapper,
        isAssistant ? styles.assistant : styles.user,
        pinned ? styles.pinned : '',
      ].join(' ')}
    >
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
