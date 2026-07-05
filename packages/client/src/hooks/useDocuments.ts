import { useState, useEffect, useCallback, useRef } from 'react'
import type { Document } from '../types'

const API = '/api'
const MAX_FILE_BYTES = 10 * 1024 * 1024

const storageKey = (userId: string): string => `docmind:attachedDocs:${userId}`

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

export function useDocuments(userId: string | null): UseDocumentsReturn {
  const [documents, setDocuments] = useState<Document[]>([])
  const [documentsLoaded, setDocumentsLoaded] = useState(false)
  const [attachedIds, setAttachedIds] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // 镜像当前选中集，供 attach/detach/清理 基于最新值计算下一个状态，
  // 而不依赖闭包里的 attachedIds（避免回调因依赖变化频繁重建）。
  const attachedIdsRef = useRef<string[]>([])

  // 统一出口：更新 state + ref，并在有 userId 时写入 localStorage。
  // 所有"改变选中集"的路径都走这里，因此持久化只发生在显式操作，
  // 不会在切换 userId 的那一帧把上个账号的选中集写进新账号的 key。
  const applyAttached = useCallback((next: string[]): void => {
    attachedIdsRef.current = next
    setAttachedIds(next)
    if (userId) {
      try { localStorage.setItem(storageKey(userId), JSON.stringify(next)) } catch { /* 存储不可用则忽略 */ }
    }
  }, [userId])

  // 拉取文档列表（一次）。
  useEffect(() => {
    fetch(`${API}/documents`)
      .then(r => r.json())
      .then((data: { documents: Document[] }) => setDocuments(data.documents))
      .catch(() => {})
      .finally(() => setDocumentsLoaded(true))
  }, [])

  // userId 变化时从 localStorage 恢复选中集（只读不写）。
  useEffect(() => {
    if (!userId) { attachedIdsRef.current = []; setAttachedIds([]); return }
    let ids: string[] = []
    try {
      const raw = localStorage.getItem(storageKey(userId))
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch { /* 解析失败当作空 */ }
    attachedIdsRef.current = ids
    setAttachedIds(ids)
  }, [userId])

  // 文档加载完成后，剔除已不存在的文档 id（被删的）。
  // 必须等 documentsLoaded：文档初始为 []，未加载完时清理会误删刚恢复的选中项。
  useEffect(() => {
    if (!documentsLoaded) return
    const existing = new Set(documents.map(d => d.id))
    const pruned = attachedIdsRef.current.filter(id => existing.has(id))
    if (pruned.length !== attachedIdsRef.current.length) applyAttached(pruned)
  }, [documents, documentsLoaded, applyAttached])

  const attach = useCallback((docId: string) => {
    if (!attachedIdsRef.current.includes(docId)) applyAttached([...attachedIdsRef.current, docId])
  }, [applyAttached])

  const detach = useCallback((docId: string) => {
    applyAttached(attachedIdsRef.current.filter(id => id !== docId))
  }, [applyAttached])

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
    const res = await fetch(`${API}/documents/${docId}`, { method: 'DELETE' })
    if (!res.ok) return
    setDocuments(prev => prev.filter(d => d.id !== docId))
    applyAttached(attachedIdsRef.current.filter(id => id !== docId))
  }, [applyAttached])

  const clearError = useCallback(() => setUploadError(null), [])

  return { documents, attachedIds, uploading, uploadError, attach, detach, upload, remove, clearError }
}
