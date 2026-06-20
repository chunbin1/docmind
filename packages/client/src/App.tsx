import { useEffect, useRef } from 'react'
import { useChat } from './hooks/useChat'
import { useDocuments } from './hooks/useDocuments'
import { useAuth } from './hooks/useAuth'
import { Message } from './components/Message'
import { ChatInput } from './components/ChatInput'
import { MemoryPanel } from './components/MemoryPanel'
import { EvalPanel } from './components/EvalPanel'
import { LoginGate } from './components/LoginGate'
import styles from './App.module.css'

export default function App() {
  const auth = useAuth()
  const {
    messages,
    streaming,
    compacting,
    sendMessage,
    stopStreaming,
    clearMessages,
    togglePin,
  } = useChat(auth.user?.id ?? null)
  const docs = useDocuments()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (auth.loading) {
    return <div className={styles.authLoading}>加载中…</div>
  }
  if (!auth.user) {
    return <LoginGate onLogin={auth.login} />
  }

  const { user } = auth
  const limitReached = !user.unlimited && (user.remaining ?? 0) <= 0

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
          <div className={styles.userBox}>
            <span className={styles.quota} title="剩余可发送消息数">
              {user.unlimited ? '∞ 无限' : `剩余 ${user.remaining ?? 0}/${user.limit}`}
            </span>
            {user.avatarUrl && (
              <img className={styles.avatar} src={user.avatarUrl} alt={user.username} />
            )}
            <span className={styles.userName}>{user.username}</span>
            <button className={styles.logoutBtn} onClick={() => void auth.logout()}>
              退出
            </button>
          </div>
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
        {limitReached && (
          <div className={styles.limitBar}>
            已达每位用户 {user.limit} 条消息上限，如需继续请联系管理员开通无限调用。
          </div>
        )}
        <ChatInput
          onSend={(msg, docIds) => void sendMessage(msg, undefined, docIds)}
          onStop={stopStreaming}
          streaming={streaming || compacting}
          disabled={limitReached}
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
