import { useState, useRef, useCallback, useEffect } from 'react'
import type { ChatMessage, UseChatReturn } from '../types'

const COMPACT_THRESHOLD = 12000
const COMPACT_KEEP_RECENT = 6
const NUDGE_INTERVAL = 10
const PIN_KEYWORDS = [
  '记住这个', '记住', '重要', '不要忘记', '关键信息',
  'remember this', 'important',
]

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3)
}

function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

export function useChat(userId: string | null): UseChatReturn {
  // Chat history is stored per account so users on the same browser never see
  // each other's conversations.
  const storageKey = userId ? `docmind:chat:${userId}` : null
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const prevKeyRef = useRef<string | null>(null)
  const turnCountRef = useRef(0)
  const messagesRef = useRef<ChatMessage[]>(messages)

  useEffect(() => { messagesRef.current = messages }, [messages])

  // Load this account's history when the user changes (empty on logout).
  // One-time migration: the first account to log in on this browser adopts the
  // pre-auth global history, then it's retired.
  useEffect(() => {
    if (!storageKey) { setMessages([]); return }
    try {
      let raw = localStorage.getItem(storageKey)
      if (!raw) {
        const legacy = localStorage.getItem('docmind:chat:messages')
        if (legacy) {
          localStorage.setItem(storageKey, legacy)
          localStorage.removeItem('docmind:chat:messages')
          raw = legacy
        }
      }
      setMessages(raw ? (JSON.parse(raw) as ChatMessage[]) : [])
    } catch {
      setMessages([])
    }
  }, [storageKey])

  // Persist immediately (no debounce) so a refresh right after an answer can't
  // lose it. Skip while streaming, when logged out, and on the render right
  // after an account switch (messages still hold the previous account's state
  // until the load effect above replaces them — writing here would clobber it).
  useEffect(() => {
    const keyChanged = prevKeyRef.current !== storageKey
    prevKeyRef.current = storageKey
    if (streaming || !storageKey || keyChanged) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(messages.slice(-50)))
    } catch {
      localStorage.setItem(storageKey, JSON.stringify(messages.slice(-20)))
    }
  }, [messages, streaming, storageKey])

  const appendToLast = (text: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, content: last.content + text }
      return updated
    })
  }

  const setLastError = (error: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content: `出错了：${error}`,
        isError: true,
      }
      return updated
    })
  }

  const triggerNudge = useCallback((): void => {
    const recent = messagesRef.current
      .filter(m => m.role !== 'summary')
      .slice(-10)
    if (recent.length === 0) return

    fetch('/api/chat/nudge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: recent }),
    })
      .then(res => {
        if (res.ok) window.dispatchEvent(new CustomEvent('memory:updated'))
      })
      .catch(() => {})
  }, [])

  const compactIfNeeded = useCallback(async (
    currentMessages: ChatMessage[],
  ): Promise<ChatMessage[]> => {
    const chatMessages = currentMessages.filter(m => m.role !== 'summary')
    if (totalTokens(chatMessages) < COMPACT_THRESHOLD) return currentMessages

    const recentMessages = chatMessages.slice(-COMPACT_KEEP_RECENT)
    const oldMessages = chatMessages.slice(0, -COMPACT_KEEP_RECENT)
    if (oldMessages.length === 0) return currentMessages

    setCompacting(true)
    try {
      const res = await fetch('/api/chat/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: oldMessages }),
      })
      if (!res.ok) throw new Error('compact failed')
      const { summary } = (await res.json()) as { summary: string }
      window.dispatchEvent(new CustomEvent('memory:updated'))

      const summaryMsg: ChatMessage = {
        role: 'summary',
        content: summary,
        compactedCount: oldMessages.length,
        compactedAt: Date.now(),
      }
      const compacted = [summaryMsg, ...recentMessages]
      setMessages(compacted)
      return compacted
    } catch {
      return currentMessages
    } finally {
      setCompacting(false)
    }
  }, [])

  const sendMessage = useCallback(async (
    message: string,
    systemPrompt?: string,
    docIds: string[] = [],
  ): Promise<void> => {
    if (!message.trim() || streaming) return

    const currentMessages = await compactIfNeeded(messages)

    const summaryMsg = currentMessages.find(m => m.role === 'summary')
    const chatHistory = currentMessages
      .filter(m => m.role !== 'summary')
      .map(({ role, content, pinned }) => ({ role, content, pinned }))

    const finalSystemPrompt = summaryMsg
      ? `${systemPrompt ?? ''}\n\n--- 早期对话摘要 ---\n${summaryMsg.content}`.trim()
      : systemPrompt

    const autoPinned = PIN_KEYWORDS.some(
      kw => message.toLowerCase().includes(kw.toLowerCase()),
    )
    setMessages(prev => [
      ...prev,
      { role: 'user', content: message, pinned: autoPinned || undefined },
      { role: 'assistant', content: '' },
    ])
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history: chatHistory,
          systemPrompt: finalSystemPrompt,
          docIds,
        }),
        signal: controller.signal,
      })

      if (res.status === 401) {
        setLastError('登录已失效，请重新登录')
        window.dispatchEvent(new CustomEvent('auth:refresh'))
        return
      }
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { limit?: number }
        setLastError(`已达每位用户 ${body.limit ?? 10} 条消息上限`)
        window.dispatchEvent(new CustomEvent('auth:refresh'))
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const json = JSON.parse(line.slice(6)) as {
              error?: string
              text?: string
              done?: boolean
            }
            if (json.error) throw new Error(json.error)
            if (json.text) appendToLast(json.text)
            if (json.done) {
              window.dispatchEvent(new CustomEvent('auth:refresh'))
              turnCountRef.current += 1
              if (turnCountRef.current % NUDGE_INTERVAL === 0) triggerNudge()
              return
            }
          } catch {
            // skip unparseable chunk
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setLastError(err.message)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [messages, streaming, compactIfNeeded, triggerNudge])

  const stopStreaming = useCallback((): void => {
    abortRef.current?.abort()
  }, [])

  const togglePin = useCallback((index: number): void => {
    setMessages(prev => prev.map((m, i) =>
      i === index ? { ...m, pinned: !m.pinned } : m,
    ))
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    if (storageKey) localStorage.removeItem(storageKey)
  }, [storageKey])

  return { messages, streaming, compacting, sendMessage, stopStreaming, clearMessages, togglePin }
}
