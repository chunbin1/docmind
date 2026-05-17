import { useEffect, useRef } from 'react'
import { useChat } from './hooks/useChat'
import { useDocuments } from './hooks/useDocuments'
import { Message } from './components/Message'
import { ChatInput } from './components/ChatInput'
import { MemoryPanel } from './components/MemoryPanel'
import { EvalPanel } from './components/EvalPanel'
import styles from './App.module.css'

export default function App() {
  const {
    messages,
    streaming,
    compacting,
    sendMessage,
    stopStreaming,
    clearMessages,
    togglePin,
  } = useChat()
  const docs = useDocuments()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>D</span>
          <span className={styles.logoText}>DocMind</span>
        </div>

        <MemoryPanel />

        <EvalPanel documents={docs.documents} />

        <div className={styles.sideBottom}>
          <button className={styles.clearBtn} onClick={clearMessages}>
            清空对话
          </button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>智能文档问答</h1>
            <p className={styles.subtitle}>
              {messages.length === 0
                ? '上传文档后即可基于文档内容提问'
                : `${messages.filter(m => m.role === 'user').length} 条对话`}
            </p>
          </div>
          <div className={styles.statusDot} title="服务正常" />
        </header>

        <div className={styles.messages}>
          {messages.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>💬</div>
              <p className={styles.emptyTitle}>开始你的第一个问题</p>
              <p className={styles.emptyDesc}>
                现在可以直接和 AI 对话，上传文档后将基于文档内容回答
              </p>
              <div className={styles.suggestions}>
                {['你好，你能做什么？', '什么是 RAG？', '解释一下 Embedding'].map(s => (
                  <button
                    key={s}
                    className={styles.suggestion}
                    onClick={() => void sendMessage(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <Message
                key={i}
                index={i}
                role={msg.role}
                content={msg.content}
                isError={msg.isError}
                pinned={msg.pinned}
                compactedCount={msg.compactedCount}
                isStreaming={
                  streaming && i === messages.length - 1 && msg.role === 'assistant'
                }
                onTogglePin={togglePin}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {compacting && (
          <div className={styles.compactingBar}>⚡ 正在压缩历史对话...</div>
        )}
        <ChatInput
          onSend={(msg, docIds) => void sendMessage(msg, undefined, docIds)}
          onStop={stopStreaming}
          streaming={streaming || compacting}
          documents={docs.documents}
          attachedIds={docs.attachedIds}
          uploading={docs.uploading}
          uploadError={docs.uploadError}
          onAttach={docs.attach}
          onDetach={docs.detach}
          onUpload={docs.upload}
          onRemoveDoc={docs.remove}
        />
      </main>
    </div>
  )
}
