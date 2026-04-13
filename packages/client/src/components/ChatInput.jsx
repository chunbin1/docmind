import { useState } from 'react'
import styles from './ChatInput.module.css'

export function ChatInput({ onSend, onStop, streaming, disabled }) {
  const [value, setValue] = useState('')

  const handleSend = () => {
    if (!value.trim() || streaming) return
    onSend(value.trim())
    setValue('')
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.inputRow}>
        <textarea
          className={styles.textarea}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行..."
          rows={1}
          disabled={disabled}
        />
        {streaming ? (
          <button className={`${styles.btn} ${styles.stop}`} onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            className={`${styles.btn} ${styles.send}`}
            onClick={handleSend}
            disabled={!value.trim() || disabled}
          >
            发送
          </button>
        )}
      </div>
      <p className={styles.hint}>Enter 发送 · Shift+Enter 换行</p>
    </div>
  )
}
