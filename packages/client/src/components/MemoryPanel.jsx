import { useState, useEffect, useCallback } from 'react'
import styles from './MemoryPanel.module.css'

const MAX_CHARS = 20000
const SOURCE_LABELS = { nudge: '自动', compact: '压缩', manual: '手动' }

export function MemoryPanel() {
  const [store, setStore] = useState({ notes: [], totalChars: 0 })
  const [adding, setAdding] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null) // null = not searching

  const fetchMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/memory')
      if (res.ok) setStore(await res.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchMemory()
    window.addEventListener('memory:updated', fetchMemory)
    return () => window.removeEventListener('memory:updated', fetchMemory)
  }, [fetchMemory])

  // Debounced semantic search
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults(null); return }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/memory/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery }),
        })
        if (res.ok) {
          const { results } = await res.json()
          setSearchResults(results)
        }
      } catch {}
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const handleDelete = async (id) => {
    await fetch(`/api/memory/notes/${id}`, { method: 'DELETE' })
    fetchMemory()
    if (searchResults) {
      setSearchResults(prev => prev.filter(n => n.id !== id))
    }
  }

  const handleAdd = async () => {
    if (!newNote.trim()) return
    await fetch('/api/memory/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: [newNote.trim()], source: 'manual' }),
    })
    setNewNote('')
    setAdding(false)
    fetchMemory()
  }

  const displayNotes = searchResults ?? store.notes
  const usage = store.totalChars / MAX_CHARS
  const isWarning = usage >= 0.75

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>记忆笔记</span>
        <span className={`${styles.badge} ${isWarning ? styles.warning : ''}`}>
          {store.notes.length} 条
        </span>
      </div>

      {/* Budget progress bar */}
      <div className={styles.budgetBar}>
        <div
          className={`${styles.budgetFill} ${isWarning ? styles.budgetWarn : ''}`}
          style={{ width: `${Math.min(usage * 100, 100)}%` }}
        />
      </div>
      {isWarning && (
        <p className={styles.warnText}>记忆接近上限，旧条目将被自动淘汰</p>
      )}

      {/* Search */}
      <input
        className={styles.searchInput}
        placeholder="语义搜索记忆..."
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
      />

      {/* Notes list */}
      <div className={styles.noteList}>
        {displayNotes.length === 0 ? (
          <p className={styles.empty}>
            {searchQuery ? '无匹配结果' : '暂无记忆笔记'}
          </p>
        ) : (
          displayNotes.map(note => (
            <div key={note.id} className={styles.noteItem}>
              <span className={styles.noteContent}>{note.content}</span>
              <span className={styles.sourceTag}>
                {SOURCE_LABELS[note.source] ?? note.source}
              </span>
              <button
                className={styles.deleteBtn}
                onClick={() => handleDelete(note.id)}
                title="删除"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add note */}
      {adding ? (
        <div className={styles.addForm}>
          <input
            className={styles.addInput}
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            placeholder="输入要记住的内容..."
            maxLength={200}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') handleAdd()
              if (e.key === 'Escape') setAdding(false)
            }}
          />
          <div className={styles.addActions}>
            <button className={styles.cancelBtn} onClick={() => setAdding(false)}>取消</button>
            <button className={styles.confirmBtn} onClick={handleAdd}>保存</button>
          </div>
        </div>
      ) : (
        <button className={styles.addBtn} onClick={() => setAdding(true)}>
          + 手动添加
        </button>
      )}
    </div>
  )
}
