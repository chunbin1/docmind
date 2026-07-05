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

export function useChat(userId: string | null): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const turnCountRef = useRef(0)
  const messagesRef = useRef<ChatMessage[]>(messages)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 卸载防护：仅在真正卸载时置 false。
  const mountedRef = useRef(true)
  // 换号防护：每次"加载本账号对话" effect 开始时递增；
  // 该 effect 内部发起的首拉 .then 和轮询递归链都捕获当时的 runId，
  // setMessages 前必须核对 runIdRef.current 未变，否则说明 userId 已经切换，结果作废。
  const runIdRef = useRef(0)

  useEffect(() => { messagesRef.current = messages }, [messages])
  // StrictMode 下 mount 会先模拟 setup→cleanup→再 setup：必须在 setup 里复位为 true，
  // 否则模拟卸载的 cleanup 把它永久置 false 后再没有机会变回 true，导致后续所有
  // setMessages/setLoading/setLoadError 被 isStale() 永久拦截（loading 卡死、消息拉不出来）。
  // StrictMode 的双调用同步发生在同一次 commit 中，早于任何 async fetch resolve，
  // 因此不会误伤真正卸载后的防护。
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
  }, [])

  const fetchMessages = useCallback(async (): Promise<ChatMessage[]> => {
    const res = await fetch('/api/chat/messages')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { messages: ChatMessage[] }
    return body.messages
  }, [])

  // 末条 generating 时轮询到 done/error 或超时。myRun 是发起本次轮询链时的 runId，
  // 只要组件仍挂载且 userId 未变（runIdRef.current === myRun）才允许 setMessages。
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
          // 超时：把末条标记为中断，停止轮询。
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
        // 轮询失败静默重试直到超时
        if (Date.now() < deadline) startPolling(deadline, myRun)
      }
    }, POLL_INTERVAL_MS)
  }, [fetchMessages, stopPolling])

  // 加载本账号对话（登出清空）。
  useEffect(() => {
    stopPolling()
    runIdRef.current += 1
    const myRun = runIdRef.current
    const isStale = () => !mountedRef.current || runIdRef.current !== myRun
    if (!userId) { setMessages([]); setLoadError(false); return }
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
  }, [userId, fetchMessages, startPolling, stopPolling])

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
    // 移除刚追加的一对 user + assistant 占位。
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

  const compactIfNeeded = useCallback(async (): Promise<void> => {
    const current = messagesRef.current
    const chat = current.filter(m => m.role !== 'summary')
    if (totalTokens(chat) < COMPACT_THRESHOLD) return
    const old = chat.slice(0, -COMPACT_KEEP_RECENT)
    if (old.length === 0) return

    // 服务端 compact 只替换它收到的 ids：若不带上已存在的旧 summary id，
    // 替换后会残留“旧 summary + 新 summary”两条，而读历史时 find(summary)
    // 只取首条，导致另一条丢失。因此要把当前已存在的 summary 行 id 也一并带上。
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
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) return
      window.dispatchEvent(new CustomEvent('memory:updated'))
      setMessages(await fetchMessages()) // 拉回服务端规范状态
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

    await compactIfNeeded()

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
        body: JSON.stringify({ message, docIds }),
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
          try {
            const json = JSON.parse(line.slice(6)) as { error?: string; text?: string; reasoning?: string; done?: boolean }
            if (json.error) throw new Error(json.error)
            if (json.reasoning) appendReasoningToLast(json.reasoning)
            if (json.text) appendToLast(json.text)
            if (json.done) {
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
      setStreaming(false)
      abortRef.current = null
    }
  }, [streaming, compactIfNeeded, triggerNudge])

  const stopStreaming = useCallback((): void => {
    // 1) 告诉服务端真正中断生成（否则它会续写并落库，刷新后又冒出完整答案）。
    fetch('/api/chat/stop', { method: 'POST' }).catch(() => {})
    // 2) 中断本地 SSE 读取。
    abortRef.current?.abort()
    setStreaming(false)
    // 3) 把末条生成中的 assistant 消息标为终态，解锁 UI（保留已生成的部分内容）。
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      if (last && last.role === 'assistant' && last.status === 'generating') {
        updated[updated.length - 1] = { ...last, status: 'done' }
      }
      return updated
    })
  }, [])

  const togglePin = useCallback((index: number): void => {
    const target = messagesRef.current[index]
    if (!target?.id) return
    const nextPinned = !target.pinned
    setMessages(prev => prev.map((m, i) => (i === index ? { ...m, pinned: nextPinned } : m)))
    fetch(`/api/chat/messages/${target.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: nextPinned }),
    }).catch(() => {})
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    fetch('/api/chat/messages', { method: 'DELETE' }).catch(() => {})
  }, [])

  return {
    messages, streaming, compacting, loading, loadError,
    sendMessage, stopStreaming, clearMessages, togglePin,
  }
}
