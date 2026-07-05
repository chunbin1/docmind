import { useState, useEffect, useRef, useCallback } from 'react'
import type { Conversation, UseConversationsReturn } from '../types'

const storageKey = (userId: string): string => `docmind:currentConv:${userId}`
const POLL_MS = 2000

export function useConversations(userId: string | null): UseConversationsReturn {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 供 deleteConversation 基于最新值计算，不受闭包过期影响。
  const conversationsRef = useRef<Conversation[]>([])
  const currentIdRef = useRef<string | null>(null)

  useEffect(() => { conversationsRef.current = conversations }, [conversations])
  useEffect(() => { currentIdRef.current = currentId }, [currentId])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchList = useCallback(async (): Promise<Conversation[]> => {
    const res = await fetch('/api/chat/conversations')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { conversations: Conversation[] }
    return body.conversations
  }, [])

  const refresh = useCallback((): void => {
    fetchList()
      .then(l => { if (mountedRef.current) setConversations(l) })
      .catch(() => {})
  }, [fetchList])

  const setCurrent = useCallback((id: string | null): void => {
    setCurrentId(id)
    currentIdRef.current = id
    if (userId) {
      try {
        if (id) localStorage.setItem(storageKey(userId), id)
        else localStorage.removeItem(storageKey(userId))
      } catch { /* 存储不可用则忽略 */ }
    }
  }, [userId])

  // 加载会话列表（userId 变化 / 登出清空）。
  useEffect(() => {
    if (!userId) { setConversations([]); setCurrentId(null); return }
    setLoading(true)
    fetchList()
      .then(l => {
        if (!mountedRef.current) return
        setConversations(l)
        let saved: string | null = null
        try { saved = localStorage.getItem(storageKey(userId)) } catch { /* ignore */ }
        const validSaved = saved && l.some(c => c.id === saved) ? saved : null
        setCurrentId(validSaved ?? l[0]?.id ?? null)
      })
      .catch(() => { if (mountedRef.current) { setConversations([]); setCurrentId(null) } })
      .finally(() => { if (mountedRef.current) setLoading(false) })
  }, [userId, fetchList])

  // 存在 generating 会话时 2s 轮询刷新列表（更新"生成中"圆点）；无则停轮询。
  useEffect(() => {
    const anyGenerating = conversations.some(c => c.generating)
    if (!anyGenerating) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(refresh, POLL_MS)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [conversations, refresh])

  const selectConversation = useCallback((id: string): void => { setCurrent(id) }, [setCurrent])
  const newConversation = useCallback((): void => { setCurrent(null) }, [setCurrent])

  const onConversationCreated = useCallback((id: string): void => {
    setConversations(prev =>
      prev.some(c => c.id === id)
        ? prev
        : [{ id, title: '新对话', updated_at: new Date().toISOString(), message_count: 0, generating: true }, ...prev],
    )
    setCurrent(id)
  }, [setCurrent])

  const deleteConversation = useCallback((id: string): void => {
    const remaining = conversationsRef.current.filter(c => c.id !== id)
    setConversations(remaining)
    if (currentIdRef.current === id) setCurrent(remaining[0]?.id ?? null)
    fetch(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(() => refresh())
      .catch(() => {})
  }, [setCurrent, refresh])

  return {
    conversations, currentId, loading,
    selectConversation, newConversation, deleteConversation, onConversationCreated, refresh,
  }
}
