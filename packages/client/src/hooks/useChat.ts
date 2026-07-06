import { useState, useRef, useCallback, useEffect } from 'react'
import type { ChatMessage, UseChatReturn } from '../types'

const COMPACT_THRESHOLD = 12000
const COMPACT_KEEP_RECENT = 6
const NUDGE_INTERVAL = 10
const POLL_INTERVAL_MS = 1000
const POLL_MAX_MS = 120000

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3)
}
function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}
function lastIsGenerating(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  return !!last && last.role === 'assistant' && last.status === 'generating'
}

export function useChat(
  userId: string | null,
  conversationId: string | null,
  onConversationCreated: (id: string) => void,
): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const turnCountRef = useRef(0)
  const messagesRef = useRef<ChatMessage[]>(messages)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // 换会话防护：conversationId 每次变化 effect 递增，飞行中的首拉/轮询核对后作废。
  const runIdRef = useRef(0)
  // 当前会话 id 的镜像，供 fetchMessages/stop 读取最新值（避免闭包过期）。
  const convIdRef = useRef<string | null>(conversationId)
  // 刚由本地惰性创建的会话：加载 effect 跳过拉取，保留乐观占位。
  const skipLoadForRef = useRef<string | null>(null)

  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { convIdRef.current = conversationId }, [conversationId])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
  }, [])

  const fetchMessages = useCallback(async (): Promise<ChatMessage[]> => {
    const cid = convIdRef.current
    if (!cid) return []
    const res = await fetch(`/api/chat/messages?conversationId=${encodeURIComponent(cid)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { messages: ChatMessage[] }
    return body.messages
  }, [])

  const startPolling = useCallback((deadline: number, myRun: number) => {
    stopPolling()
    pollTimerRef.current = setTimeout(async () => {
      const isStale = () => !mountedRef.current || runIdRef.current !== myRun
      try {
        const msgs = await fetchMessages()
        if (isStale()) return
        setMessages(msgs)
        if (lastIsGenerating(msgs) && Date.now() < deadline) {
          startPolling(deadline, myRun)
        } else if (lastIsGenerating(msgs)) {
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.status === 'generating') {
              updated[updated.length - 1] = { ...last, status: 'error', content: last.content || '回答已中断', isError: true }
            }
            return updated
          })
        }
      } catch {
        if (isStale()) return
        if (Date.now() < deadline) startPolling(deadline, myRun)
      }
    }, POLL_INTERVAL_MS)
  }, [fetchMessages, stopPolling])

  // 加载当前会话消息（userId/会话变化触发；草稿 conversationId=null 时清空）。
  useEffect(() => {
    stopPolling()
    runIdRef.current += 1
    const myRun = runIdRef.current
    const isStale = () => !mountedRef.current || runIdRef.current !== myRun
    // 切会话：中断上一个会话飞行中的客户端 reader（不调 /chat/stop，服务端照常续写落库）。
    // 惰性建会话时 abortRef.current 仍为 null（controller 稍后才在 sendMessage 里创建），此处不会误伤即将开始的流。
    abortRef.current?.abort()
    if (!userId || !conversationId) { setMessages([]); setLoadError(false); setLoading(false); return }
    // 本地刚创建的会话：跳过拉取，保留 sendMessage 里已放的乐观占位。
    if (skipLoadForRef.current === conversationId) {
      skipLoadForRef.current = null
      setLoading(false)
      return
    }
    setLoading(true); setLoadError(false)
    fetchMessages()
      .then(msgs => {
        if (isStale()) return
        setMessages(msgs)
        if (lastIsGenerating(msgs)) startPolling(Date.now() + POLL_MAX_MS, myRun)
      })
      .catch(() => { if (!isStale()) { setMessages([]); setLoadError(true) } })
      .finally(() => { if (!isStale()) setLoading(false) })
    return () => { stopPolling() }
  }, [userId, conversationId, fetchMessages, startPolling, stopPolling])

  const appendToLast = (text: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, content: last.content + text }
      return updated
    })
  }

  const appendReasoningToLast = (text: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + text }
      return updated
    })
  }

  const setLastError = (error: string): void => {
    setMessages(prev => {
      const updated = [...prev]
      updated[updated.length - 1] = {
        ...updated[updated.length - 1], content: `出错了：${error}`, isError: true, status: 'error',
      }
      return updated
    })
  }

  const rollbackOptimistic = (): void => {
    setMessages(prev => prev.slice(0, -2))
  }

  const triggerNudge = useCallback((): void => {
    const recent = messagesRef.current.filter(m => m.role !== 'summary').slice(-10)
    if (recent.length === 0) return
    fetch('/api/chat/nudge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: recent }),
    })
      .then(res => { if (res.ok) window.dispatchEvent(new CustomEvent('memory:updated')) })
      .catch(() => {})
  }, [])

  const compactIfNeeded = useCallback(async (convId: string): Promise<void> => {
    const current = messagesRef.current
    const chat = current.filter(m => m.role !== 'summary')
    if (totalTokens(chat) < COMPACT_THRESHOLD) return
    const old = chat.slice(0, -COMPACT_KEEP_RECENT)
    if (old.length === 0) return

    const existingSummaryIds = current
      .filter(m => m.role === 'summary' && m.id)
      .map(m => m.id as string)
    const oldIds = old.map(m => m.id).filter((x): x is string => !!x)
    const ids = [...existingSummaryIds, ...oldIds]
    if (ids.length === 0) return

    setCompacting(true)
    try {
      const res = await fetch('/api/chat/compact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, ids }),
      })
      if (!res.ok) return
      window.dispatchEvent(new CustomEvent('memory:updated'))
      setMessages(await fetchMessages())
    } catch {
      // 压缩失败保持原样
    } finally {
      setCompacting(false)
    }
  }, [fetchMessages])

  const sendMessage = useCallback(async (
    message: string,
    docIds: string[] = [],
  ): Promise<void> => {
    if (!message.trim() || streaming || lastIsGenerating(messagesRef.current)) return

    // 惰性建会话：草稿态（conversationId=null）首发时先创建。
    let convId = conversationId
    if (!convId) {
      try {
        const res = await fetch('/api/chat/conversations', { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { id: string }
        convId = body.id
        convIdRef.current = convId
        skipLoadForRef.current = convId  // 阻止随后的加载 effect 冲掉乐观占位
        onConversationCreated(convId)
      } catch {
        return // 建会话失败：无乐观占位可回滚，直接放弃
      }
    }

    await compactIfNeeded(convId)

    setMessages(prev => [
      ...prev,
      { role: 'user', content: message, status: 'done' },
      { role: 'assistant', content: '', status: 'generating', reasoning: '' },
    ])
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, message, docIds }),
        signal: controller.signal,
      })

      if (res.status === 401) {
        setLastError('登录已失效，请重新登录')
        window.dispatchEvent(new CustomEvent('auth:refresh')); return
      }
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { limit?: number }
        setLastError(`已达每位用户 ${body.limit ?? 10} 条消息上限`)
        window.dispatchEvent(new CustomEvent('auth:refresh')); return
      }
      if (res.status === 409) { rollbackOptimistic(); return }
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
          // 归属守卫：本流已被切会话/新流取代时不再消费/落地本流的 chunk，避免污染当前会话的 messages。
          // 同时核对 abortRef.current!==controller（已被新流接管）和 controller.signal.aborted
          // （已被 abort 但 reader 尚未自然结束、finally 还没来得及清 abortRef——
          // reader.read() 的 rejection 与已入队的 chunk 之间存在一个消费窗口，仅凭前者不够）。
          if (abortRef.current !== controller || controller.signal.aborted) break
          try {
            const json = JSON.parse(line.slice(6)) as { error?: string; text?: string; reasoning?: string; done?: boolean }
            if (json.error) throw new Error(json.error)
            if (json.reasoning) appendReasoningToLast(json.reasoning)
            if (json.text) appendToLast(json.text)
            if (json.done) {
              if (abortRef.current !== controller || controller.signal.aborted) return
              setMessages(prev => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                if (last && last.role === 'assistant') updated[updated.length - 1] = { ...last, status: 'done' }
                return updated
              })
              window.dispatchEvent(new CustomEvent('auth:refresh'))
              turnCountRef.current += 1
              if (turnCountRef.current % NUDGE_INTERVAL === 0) triggerNudge()
              return
            }
          } catch { /* skip unparseable chunk */ }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') setLastError(err.message)
    } finally {
      // 归属守卫：本流已被切会话/新流取代时，不再动共享的 streaming/abortRef 状态
      // （那属于新流的所有权，被本流的 finally 清掉会导致新流"看起来"没在流式）。
      if (abortRef.current === controller) {
        setStreaming(false)
        abortRef.current = null
      }
    }
  }, [streaming, conversationId, compactIfNeeded, triggerNudge, onConversationCreated])

  const stopStreaming = useCallback((): void => {
    const cid = convIdRef.current
    // 1) 告诉服务端真正中断该会话的生成。
    fetch('/api/chat/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: cid }),
    }).catch(() => {})
    // 2) 中断本地 SSE 读取。
    abortRef.current?.abort()
    setStreaming(false)
    // 3) 末条生成中的 assistant 标为终态，解锁 UI（保留已生成部分）。
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      if (last && last.role === 'assistant' && last.status === 'generating') {
        updated[updated.length - 1] = { ...last, status: 'done' }
      }
      return updated
    })
  }, [])

  return {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming,
  }
}
