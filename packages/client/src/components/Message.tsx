import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import type { MessageRole } from '../types'
import styles from './Message.module.css'

interface ReasoningBlockProps {
  reasoning: string
  isStreaming: boolean
}

function ReasoningBlock({ reasoning, isStreaming }: ReasoningBlockProps) {
  // 流式中默认展开（实时看思考），生成结束/历史消息默认折叠。
  const [expanded, setExpanded] = useState(isStreaming)
  useEffect(() => { if (!isStreaming) setExpanded(false) }, [isStreaming])

  return (
    <div className={styles.reasoningBlock}>
      <button className={styles.reasoningToggle} onClick={() => setExpanded(v => !v)}>
        <span>💭 {isStreaming ? '思考中…' : '思考过程'}</span>
        <span className={styles.reasoningChevron}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div className={styles.reasoningContent}>{reasoning}</div>}
    </div>
  )
}

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
  compactedCount?: number
  reasoning?: string
}

export function Message({
  role,
  content,
  isError,
  isStreaming,
  compactedCount,
  reasoning,
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
      ].join(' ')}
    >
      <div className={styles.avatar}>
        {isAssistant ? 'AI' : '你'}
      </div>
      <div className={`${styles.bubble} ${isError ? styles.error : ''}`}>
        {isAssistant ? (
          <div className="markdown">
            {reasoning && <ReasoningBlock reasoning={reasoning} isStreaming={!!isStreaming} />}
            <ReactMarkdown>{content || ' '}</ReactMarkdown>
            {isStreaming && <span className={styles.cursor} />}
          </div>
        ) : (
          <p>{content}</p>
        )}
      </div>
    </div>
  )
}
