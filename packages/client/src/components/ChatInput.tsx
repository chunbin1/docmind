import { useState } from 'react'
import type { Document } from '../types'
import { DocumentTag } from './DocumentTag'
import { DocumentPicker } from './DocumentPicker'
import styles from './ChatInput.module.css'

interface ChatInputProps {
  onSend: (message: string, docIds: string[]) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  documents: Document[]
  attachedIds: string[]
  uploading: boolean
  uploadError: string | null
  onAttach: (docId: string) => void
  onDetach: (docId: string) => void
  onUpload: (file: File) => void
  onRemoveDoc: (docId: string) => void
}

export function ChatInput({
  onSend, onStop, streaming, disabled,
  documents, attachedIds, uploading, uploadError,
  onAttach, onDetach, onUpload, onRemoveDoc,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  const handleSend = (): void => {
    if (!value.trim() || streaming) return
    onSend(value.trim(), attachedIds)
    setValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={styles.container}>
      {documents.length > 0 && (
        <div className={styles.chips}>
          {documents.map(doc => {
            const selected = attachedIds.includes(doc.id)
            return (
              <DocumentTag
                key={doc.id}
                filename={doc.filename}
                selected={selected}
                onToggle={() => (selected ? onDetach(doc.id) : onAttach(doc.id))}
              />
            )
          })}
        </div>
      )}

      <div className={styles.inputRow}>
        <button
          className={styles.paperclip}
          onClick={() => setPickerOpen(p => !p)}
          title="附加文档"
          type="button"
        >
          📎
        </button>

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

      {pickerOpen && (
        <DocumentPicker
          documents={documents}
          attachedIds={attachedIds}
          uploading={uploading}
          uploadError={uploadError}
          onAttach={onAttach}
          onDetach={onDetach}
          onUpload={onUpload}
          onRemove={onRemoveDoc}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
