import { useState, useEffect, useCallback } from 'react'
import type { Document } from '../types'

const API = 'http://localhost:3001/api'
const MAX_FILE_BYTES = 10 * 1024 * 1024

export interface UseDocumentsReturn {
  documents: Document[]
  attachedIds: string[]
  uploading: boolean
  uploadError: string | null
  attach: (docId: string) => void
  detach: (docId: string) => void
  upload: (file: File) => Promise<void>
  remove: (docId: string) => Promise<void>
  clearError: () => void
}

export function useDocuments(): UseDocumentsReturn {
  const [documents, setDocuments] = useState<Document[]>([])
  const [attachedIds, setAttachedIds] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/documents`)
      .then(r => r.json())
      .then((data: { documents: Document[] }) => setDocuments(data.documents))
      .catch(() => {})
  }, [])

  const attach = useCallback((docId: string) => {
    setAttachedIds(prev => prev.includes(docId) ? prev : [...prev, docId])
  }, [])

  const detach = useCallback((docId: string) => {
    setAttachedIds(prev => prev.filter(id => id !== docId))
  }, [])

  const upload = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setUploadError('文件超过 10MB 限制')
      return
    }
    if (file.type !== 'application/pdf') {
      setUploadError('只支持 PDF 文件')
      return
    }

    setUploading(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${API}/documents`, { method: 'POST', body: form })
      const data = await res.json() as { document?: Document; error?: string }
      if (!res.ok) {
        setUploadError(data.error ?? '上传失败')
        return
      }
      if (data.document) {
        setDocuments(prev => [data.document!, ...prev])
        attach(data.document.id)
      }
    } catch {
      setUploadError('网络错误，上传失败')
    } finally {
      setUploading(false)
    }
  }, [attach])

  const remove = useCallback(async (docId: string) => {
    await fetch(`${API}/documents/${docId}`, { method: 'DELETE' })
    setDocuments(prev => prev.filter(d => d.id !== docId))
    setAttachedIds(prev => prev.filter(id => id !== docId))
  }, [])

  const clearError = useCallback(() => setUploadError(null), [])

  return { documents, attachedIds, uploading, uploadError, attach, detach, upload, remove, clearError }
}
