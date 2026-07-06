import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { AuthUser } from '../hooks/useAuth'
import { useChat } from '../hooks/useChat'
import { useConversations } from '../hooks/useConversations'
import { useDocuments } from '../hooks/useDocuments'
import { Message } from './Message'
import { ChatInput } from './ChatInput'
import { ConversationList } from './ConversationList'
import { MemoryPanel } from './MemoryPanel'
import { EvalPanel } from './EvalPanel'
import styles from '../App.module.css'

interface Props {
  user: AuthUser
  onLogout: () => void
}

export function ChatView({ user, onLogout }: Props) {
  const convs = useConversations(user.id)
  const {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming,
  } = useChat(user.id, convs.currentId, convs.onConversationCreated)
  const docs = useDocuments(user.id)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const limitReached = !user.unlimited && (user.remaining ?? 0) <= 0
  const generating = streaming || (messages[messages.length - 1]?.status === 'generating')

  // 发送后刷新会话列表：更新标题（首句自动生成）、生成中圆点、排序。
  const handleSend = (msg: string, docIds?: string[]): void => {
    void sendMessage(msg, docIds).then(() => convs.refresh())
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>D</span>
          <span className={styles.logoText}>DocMind</span>
        </div>

        <ConversationList
          conversations={convs.conversations}
          currentId={convs.currentId}
          onSelect={convs.selectConversation}
          onNew={convs.newConversation}
          onDelete={convs.deleteConversation}
        />

        <MemoryPanel />

        {user.isAdmin && <EvalPanel documents={docs.documents} />}
        {user.isAdmin && (
          <Link to="/traces" className={styles.tracesLink}>🔍 Traces</Link>
        )}
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
            <button className={styles.logoutBtn} onClick={onLogout}>
              退出
            </button>
          </div>
        </header>

        <div className={styles.messages}>
          {loading && <div className={styles.compactingBar}>正在加载对话…</div>}
          {loadError && <div className={styles.limitBar}>对话加载失败，请刷新重试。</div>}
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
                    onClick={() => handleSend(s)}
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
                role={msg.role}
                content={msg.content}
                isError={msg.isError}
                compactedCount={msg.compactedCount}
                reasoning={msg.reasoning}
                isStreaming={
                  streaming && i === messages.length - 1 && msg.role === 'assistant'
                }
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
          onSend={handleSend}
          onStop={stopStreaming}
          streaming={generating || compacting}
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
