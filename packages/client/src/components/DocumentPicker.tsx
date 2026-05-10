import { useRef } from 'react'
import type { Document } from '../types'
import styles from './DocumentPicker.module.css'

interface DocumentPickerProps {
  documents: Document[]
  attachedIds: string[]
  uploading: boolean
  uploadError: string | null
  onAttach: (docId: string) => void
  onDetach: (docId: string) => void
  onUpload: (file: File) => void
  onRemove: (docId: string) => void
  onClose: () => void
}

export function DocumentPicker({
  documents, attachedIds, uploading, uploadError,
  onAttach, onDetach, onUpload, onRemove, onClose,
}: DocumentPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onUpload(file)
    e.target.value = ''
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.popover} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span>文档</span>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>

        {uploadError && (
          <div className={styles.error}>{uploadError}</div>
        )}

        <button
          className={styles.uploadBtn}
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? '上传中…' : '+ 上传 PDF'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {documents.length === 0 && !uploading && (
          <p className={styles.empty}>暂无文档，上传 PDF 开始使用</p>
        )}

        <ul className={styles.list}>
          {documents.map(doc => {
            const attached = attachedIds.includes(doc.id)
            return (
              <li key={doc.id} className={styles.item}>
                <label className={styles.label}>
                  <input
                    type="checkbox"
                    checked={attached}
                    onChange={() => attached ? onDetach(doc.id) : onAttach(doc.id)}
                  />
                  <span className={styles.filename} title={doc.filename}>{doc.filename}</span>
                  <span className={styles.meta}>{doc.chunk_count} 块</span>
                </label>
                <button
                  className={styles.deleteBtn}
                  onClick={() => onRemove(doc.id)}
                  title="删除文档"
                >
                  🗑
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
