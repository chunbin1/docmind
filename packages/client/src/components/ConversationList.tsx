import type { Conversation } from '../types'
import styles from '../App.module.css'

interface ConversationListProps {
  conversations: Conversation[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function ConversationList({ conversations, currentId, onSelect, onNew, onDelete }: ConversationListProps) {
  return (
    <div className={styles.convPanel}>
      <button className={styles.newConvBtn} onClick={onNew}>＋ 新建对话</button>
      <div className={styles.convList}>
        {conversations.map(c => (
          <div
            key={c.id}
            className={`${styles.convItem} ${c.id === currentId ? styles.convItemActive : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {c.generating && <span className={styles.convDot} title="生成中" />}
            <span className={styles.convTitle}>{c.title}</span>
            <button
              className={styles.convDelete}
              title="删除对话"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm('确定删除这条对话？')) onDelete(c.id)
              }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
