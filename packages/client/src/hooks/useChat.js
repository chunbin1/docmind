import { useState, useRef, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'docmind:chat:messages'
const COMPACT_THRESHOLD = 12000  // 估算 token 超过此值触发压缩
const COMPACT_KEEP_RECENT = 6    // 压缩时保留最近 N 条完整消息
const NUDGE_INTERVAL = 10        // 每 N 轮触发一次后台记忆提取
const PIN_KEYWORDS = ['记住这个', '记住', '重要', '不要忘记', '关键信息', 'remember this', 'important']

function estimateTokens(text) {
  return Math.ceil((text || '').length / 3)
}

function totalTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

/**
 * useChat — 管理消息历史和流式请求
 * 把 API 逻辑从 UI 组件里分离出来，这是 AI 应用工程化的标准做法
 */
export function useChat() {
  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const abortRef = useRef(null)
  const saveTimerRef = useRef(null)
  const turnCountRef = useRef(0)       // tracks completed turns for nudge
  const messagesRef = useRef(messages) // stable ref for use in callbacks

  // keep messagesRef in sync
  useEffect(() => { messagesRef.current = messages }, [messages])

  // 持久化：流式结束后 debounce 500ms 写入 localStorage
  useEffect(() => {
    if (streaming) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)))
      } catch {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-20)))
      }
    }, 500)
    return () => clearTimeout(saveTimerRef.current)
  }, [messages, streaming])

  const appendToLast = (text) => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      updated[updated.length - 1] = { ...last, content: last.content + text }
      return updated
    })
  }

  const setLastError = (error) => {
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

  // 后台静默提取记忆（fire-and-forget，失败无声）
  const triggerNudge = useCallback(() => {
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

  // 自动压缩：把旧消息送给 AI 生成摘要，替换旧消息（参考 Claude Code 的做法）
  const compactIfNeeded = useCallback(async (currentMessages) => {
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
      const { summary } = await res.json()
      // facts are persisted server-side; notify MemoryPanel to refresh
      window.dispatchEvent(new CustomEvent('memory:updated'))

      const summaryMsg = {
        role: 'summary',
        content: summary,
        compactedCount: oldMessages.length,
        compactedAt: Date.now(),
      }
      const compacted = [summaryMsg, ...recentMessages]
      setMessages(compacted)
      return compacted
    } catch {
      // 压缩失败静默降级，继续用原始消息
      return currentMessages
    } finally {
      setCompacting(false)
    }
  }, [])

  const sendMessage = useCallback(async (message, systemPrompt) => {
    if (!message.trim() || streaming) return

    // 压缩检查（如果触发，等待完成再发送）
    const currentMessages = await compactIfNeeded(messages)

    // 构造 history：summary 转为 systemPrompt 追加内容，其余消息正常传
    const summaryMsg = currentMessages.find(m => m.role === 'summary')
    const chatHistory = currentMessages
      .filter(m => m.role !== 'summary')
      .map(({ role, content, pinned }) => ({ role, content, pinned }))

    const finalSystemPrompt = summaryMsg
      ? `${systemPrompt || ''}\n\n--- 早期对话摘要 ---\n${summaryMsg.content}`.trim()
      : systemPrompt

    const autoPinned = PIN_KEYWORDS.some(kw => message.toLowerCase().includes(kw.toLowerCase()))
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
        body: JSON.stringify({ message, history: chatHistory, systemPrompt: finalSystemPrompt }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // 最后一行可能不完整，留到下次

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const json = JSON.parse(line.slice(6))
            if (json.error) throw new Error(json.error)
            if (json.text) appendToLast(json.text)
            if (json.done) {
              // Increment turn counter; trigger nudge every NUDGE_INTERVAL turns
              turnCountRef.current += 1
              if (turnCountRef.current % NUDGE_INTERVAL === 0) {
                triggerNudge()
              }
              return
            }
          } catch (parseErr) {
            // 跳过无法解析的 chunk
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLastError(err.message)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [messages, streaming, compactIfNeeded, triggerNudge])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const togglePin = useCallback((index) => {
    setMessages(prev => prev.map((m, i) =>
      i === index ? { ...m, pinned: !m.pinned } : m
    ))
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  return { messages, streaming, compacting, sendMessage, stopStreaming, clearMessages, togglePin }
}
