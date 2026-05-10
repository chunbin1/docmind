# Frontend TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all frontend source files from JavaScript/JSX to TypeScript/TSX, adding strict types throughout.

**Architecture:** Bottom-up conversion — shared types first, then the central hook, then leaf components, then App and entry point. Each file is fully typed before moving on; `tsc --noEmit` is the test gate after every task.

**Tech Stack:** TypeScript 5, React 19, Vite 6, CSS Modules, react-markdown

---

## File Map

| Current | After | Role |
|---|---|---|
| *(new)* | `src/types.ts` | Shared domain types (ChatMessage, MemoryNote, etc.) |
| *(new)* | `src/vite-env.d.ts` | Vite client type reference |
| *(new)* | `tsconfig.json` | TypeScript compiler config |
| `vite.config.js` | `vite.config.ts` | Vite config (rename only) |
| `src/main.jsx` | `src/main.tsx` | React entry point |
| `src/hooks/useChat.js` | `src/hooks/useChat.ts` | Core chat state hook |
| `src/App.jsx` | `src/App.tsx` | Root layout component |
| `src/components/Message.jsx` | `src/components/Message.tsx` | Message bubble + summary bar |
| `src/components/ChatInput.jsx` | `src/components/ChatInput.tsx` | Input + send/stop button |
| `src/components/MemoryPanel.jsx` | `src/components/MemoryPanel.tsx` | Memory notes sidebar panel |
| `index.html` | `index.html` | Update script src from `.jsx` → `.tsx` |

CSS files are untouched.

---

## Task 0: Install TypeScript and configure the compiler

**Files:**
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/src/vite-env.d.ts`
- Modify: `packages/client/package.json` (add typescript devDep)

- [ ] **Step 1: Install typescript**

```bash
cd packages/client && pnpm add -D typescript
```

Expected: `packages/client/package.json` now has `"typescript"` in `devDependencies`.

- [ ] **Step 2: Create tsconfig.json**

Create `packages/client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vite-env.d.ts**

Create `packages/client/src/vite-env.d.ts`:

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 4: Run tsc to confirm zero .ts files → zero errors**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0, no output (no `.ts` files yet, nothing to check).

- [ ] **Step 5: Commit**

```bash
git add packages/client/tsconfig.json packages/client/src/vite-env.d.ts packages/client/package.json pnpm-lock.yaml
git commit -m "chore(client): add TypeScript compiler setup"
```

---

## Task 1: Create shared types file

**Files:**
- Create: `packages/client/src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
// packages/client/src/types.ts

export type MessageRole = 'user' | 'assistant' | 'summary'

/** A single entry in the conversation history */
export interface ChatMessage {
  role: MessageRole
  content: string
  /** If true, this message is never trimmed or compacted */
  pinned?: boolean
  /** Set to true when the stream ended in an error */
  isError?: boolean
  /** Only present on role==='summary' messages */
  compactedCount?: number
  /** Unix ms timestamp when compaction happened */
  compactedAt?: number
}

/** A single persisted memory note */
export interface MemoryNote {
  id: string
  content: string
  source: 'nudge' | 'compact' | 'manual' | string
}

/** Shape of GET /api/memory response */
export interface MemoryStore {
  notes: MemoryNote[]
  totalChars: number
}

/** What useChat exposes to components */
export interface UseChatReturn {
  messages: ChatMessage[]
  streaming: boolean
  compacting: boolean
  sendMessage: (message: string, systemPrompt?: string) => Promise<void>
  stopStreaming: () => void
  clearMessages: () => void
  togglePin: (index: number) => void
}
```

- [ ] **Step 2: Run tsc — expect zero errors**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/types.ts
git commit -m "feat(client): add shared TypeScript type definitions"
```

---

## Task 2: Convert useChat.js → useChat.ts

**Files:**
- Create: `packages/client/src/hooks/useChat.ts`
- Delete: `packages/client/src/hooks/useChat.js`

- [ ] **Step 1: Create useChat.ts**

Create `packages/client/src/hooks/useChat.ts` with the full typed implementation:

```typescript
import { useState, useRef, useCallback, useEffect } from 'react'
import type { ChatMessage, UseChatReturn } from '../types'

const STORAGE_KEY = 'docmind:chat:messages'
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

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? (JSON.parse(saved) as ChatMessage[]) : []
    } catch {
      return []
    }
  })
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnCountRef = useRef(0)
  const messagesRef = useRef<ChatMessage[]>(messages)

  useEffect(() => { messagesRef.current = messages }, [messages])

  useEffect(() => {
    if (streaming) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)))
      } catch {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-20)))
      }
    }, 500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [messages, streaming])

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
        }),
        signal: controller.signal,
      })

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
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  return { messages, streaming, compacting, sendMessage, stopStreaming, clearMessages, togglePin }
}
```

- [ ] **Step 2: Delete the old JS file**

```bash
rm packages/client/src/hooks/useChat.js
```

- [ ] **Step 3: Run tsc — expect zero errors**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0. If you see errors about JSX files importing useChat, ignore them — those files haven't been converted yet and aren't included in tsconfig's `src` glob for `.ts` purposes. (Vite still serves them fine.)

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/hooks/useChat.ts packages/client/src/hooks/useChat.js
git commit -m "feat(client): convert useChat to TypeScript"
```

---

## Task 3: Convert Message.jsx → Message.tsx

**Files:**
- Create: `packages/client/src/components/Message.tsx`
- Delete: `packages/client/src/components/Message.jsx`

- [ ] **Step 1: Create Message.tsx**

```typescript
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { MessageRole } from '../types'
import styles from './Message.module.css'

interface SummaryBarProps {
  content: string
  compactedCount: number
}

function SummaryBar({ content, compactedCount }: SummaryBarProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={styles.summaryBar}>
      <button
        className={styles.summaryToggle}
        onClick={() => setExpanded(v => !v)}
      >
        <span className={styles.summaryIcon}>⚡</span>
        已自动压缩 {compactedCount} 条早期对话
        <span className={styles.summaryChevron}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className={styles.summaryContent}>{content}</div>
      )}
    </div>
  )
}

interface MessageProps {
  role: MessageRole
  content: string
  isError?: boolean
  isStreaming?: boolean
  pinned?: boolean
  compactedCount?: number
  index: number
  onTogglePin?: (index: number) => void
}

export function Message({
  role,
  content,
  isError,
  isStreaming,
  pinned,
  compactedCount,
  index,
  onTogglePin,
}: MessageProps) {
  if (role === 'summary') {
    return <SummaryBar content={content} compactedCount={compactedCount ?? 0} />
  }

  const isAssistant = role === 'assistant'

  return (
    <div
      className={[
        styles.wrapper,
        isAssistant ? styles.assistant : styles.user,
        pinned ? styles.pinned : '',
      ].join(' ')}
    >
      <div className={styles.avatar}>
        {isAssistant ? 'AI' : '你'}
      </div>
      <div className={`${styles.bubble} ${isError ? styles.error : ''}`}>
        {isAssistant ? (
          <div className="markdown">
            <ReactMarkdown>{content || ' '}</ReactMarkdown>
            {isStreaming && <span className={styles.cursor} />}
          </div>
        ) : (
          <p>{content}</p>
        )}
        {onTogglePin && (
          <button
            className={`${styles.pinBtn} ${pinned ? styles.pinActive : ''}`}
            onClick={() => onTogglePin(index)}
            title={pinned ? '取消固定' : '固定此消息（截断时不丢弃）'}
          >
            {pinned ? '📌' : '📍'}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/client/src/components/Message.jsx
```

- [ ] **Step 3: Run tsc**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/Message.tsx packages/client/src/components/Message.jsx
git commit -m "feat(client): convert Message component to TypeScript"
```

---

## Task 4: Convert ChatInput.jsx → ChatInput.tsx

**Files:**
- Create: `packages/client/src/components/ChatInput.tsx`
- Delete: `packages/client/src/components/ChatInput.jsx`

- [ ] **Step 1: Create ChatInput.tsx**

```typescript
import { useState } from 'react'
import styles from './ChatInput.module.css'

interface ChatInputProps {
  onSend: (message: string) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
}

export function ChatInput({ onSend, onStop, streaming, disabled }: ChatInputProps) {
  const [value, setValue] = useState('')

  const handleSend = (): void => {
    if (!value.trim() || streaming) return
    onSend(value.trim())
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
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/client/src/components/ChatInput.jsx
```

- [ ] **Step 3: Run tsc**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/ChatInput.tsx packages/client/src/components/ChatInput.jsx
git commit -m "feat(client): convert ChatInput component to TypeScript"
```

---

## Task 5: Convert MemoryPanel.jsx → MemoryPanel.tsx

**Files:**
- Create: `packages/client/src/components/MemoryPanel.tsx`
- Delete: `packages/client/src/components/MemoryPanel.jsx`

- [ ] **Step 1: Create MemoryPanel.tsx**

```typescript
import { useState, useEffect, useCallback } from 'react'
import type { MemoryNote, MemoryStore } from '../types'
import styles from './MemoryPanel.module.css'

const MAX_CHARS = 20000
const SOURCE_LABELS: Record<string, string> = {
  nudge: '自动',
  compact: '压缩',
  manual: '手动',
}

export function MemoryPanel() {
  const [store, setStore] = useState<MemoryStore>({ notes: [], totalChars: 0 })
  const [adding, setAdding] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MemoryNote[] | null>(null)

  const fetchMemory = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/memory')
      if (res.ok) setStore((await res.json()) as MemoryStore)
    } catch {
      // silent — panel is non-critical
    }
  }, [])

  useEffect(() => {
    void fetchMemory()
    window.addEventListener('memory:updated', fetchMemory)
    return () => window.removeEventListener('memory:updated', fetchMemory)
  }, [fetchMemory])

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults(null); return }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/memory/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery }),
        })
        if (res.ok) {
          const { results } = (await res.json()) as { results: MemoryNote[] }
          setSearchResults(results)
        }
      } catch {
        // silent
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const handleDelete = async (id: string): Promise<void> => {
    await fetch(`/api/memory/notes/${id}`, { method: 'DELETE' })
    void fetchMemory()
    if (searchResults) {
      setSearchResults(prev => prev?.filter(n => n.id !== id) ?? null)
    }
  }

  const handleAdd = async (): Promise<void> => {
    if (!newNote.trim()) return
    await fetch('/api/memory/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: [newNote.trim()], source: 'manual' }),
    })
    setNewNote('')
    setAdding(false)
    void fetchMemory()
  }

  const displayNotes = searchResults ?? store.notes
  const usage = store.totalChars / MAX_CHARS
  const isWarning = usage >= 0.75

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>记忆笔记</span>
        <span className={`${styles.badge} ${isWarning ? styles.warning : ''}`}>
          {store.notes.length} 条
        </span>
      </div>

      <div className={styles.budgetBar}>
        <div
          className={`${styles.budgetFill} ${isWarning ? styles.budgetWarn : ''}`}
          style={{ width: `${Math.min(usage * 100, 100)}%` }}
        />
      </div>
      {isWarning && (
        <p className={styles.warnText}>记忆接近上限，旧条目将被自动淘汰</p>
      )}

      <input
        className={styles.searchInput}
        placeholder="语义搜索记忆..."
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
      />

      <div className={styles.noteList}>
        {displayNotes.length === 0 ? (
          <p className={styles.empty}>
            {searchQuery ? '无匹配结果' : '暂无记忆笔记'}
          </p>
        ) : (
          displayNotes.map(note => (
            <div key={note.id} className={styles.noteItem}>
              <span className={styles.noteContent}>{note.content}</span>
              <span className={styles.sourceTag}>
                {SOURCE_LABELS[note.source] ?? note.source}
              </span>
              <button
                className={styles.deleteBtn}
                onClick={() => void handleDelete(note.id)}
                title="删除"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {adding ? (
        <div className={styles.addForm}>
          <input
            className={styles.addInput}
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            placeholder="输入要记住的内容..."
            maxLength={200}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') void handleAdd()
              if (e.key === 'Escape') setAdding(false)
            }}
          />
          <div className={styles.addActions}>
            <button className={styles.cancelBtn} onClick={() => setAdding(false)}>
              取消
            </button>
            <button className={styles.confirmBtn} onClick={() => void handleAdd()}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.addBtn} onClick={() => setAdding(true)}>
          + 手动添加
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/client/src/components/MemoryPanel.jsx
```

- [ ] **Step 3: Run tsc**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/MemoryPanel.tsx packages/client/src/components/MemoryPanel.jsx
git commit -m "feat(client): convert MemoryPanel component to TypeScript"
```

---

## Task 6: Convert App.jsx → App.tsx

**Files:**
- Create: `packages/client/src/App.tsx`
- Delete: `packages/client/src/App.jsx`

- [ ] **Step 1: Create App.tsx**

```typescript
import { useEffect, useRef } from 'react'
import { useChat } from './hooks/useChat'
import { Message } from './components/Message'
import { ChatInput } from './components/ChatInput'
import { MemoryPanel } from './components/MemoryPanel'
import styles from './App.module.css'

export default function App() {
  const {
    messages,
    streaming,
    compacting,
    sendMessage,
    stopStreaming,
    clearMessages,
    togglePin,
  } = useChat()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>D</span>
          <span className={styles.logoText}>DocMind</span>
        </div>

        <div className={styles.sideSection}>
          <p className={styles.sideLabel}>文档</p>
          <div className={styles.emptyDocs}>
            <p>里程碑 2 实现</p>
            <p>上传文档开始问答</p>
          </div>
        </div>

        <MemoryPanel />

        <div className={styles.sideBottom}>
          <button className={styles.clearBtn} onClick={clearMessages}>
            清空对话
          </button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>智能文档问答</h1>
            <p className={styles.subtitle}>
              {messages.length === 0
                ? '上传文档后即可基于文档内容提问'
                : `${messages.filter(m => m.role === 'user').length} 条对话`}
            </p>
          </div>
          <div className={styles.statusDot} title="服务正常" />
        </header>

        <div className={styles.messages}>
          {messages.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>💬</div>
              <p className={styles.emptyTitle}>开始你的第一个问题</p>
              <p className={styles.emptyDesc}>
                现在可以直接和 AI 对话，上传文档后将基于文档内容回答
              </p>
              <div className={styles.suggestions}>
                {['你好，你能做什么？', '什么是 RAG？', '解释一下 Embedding'].map(s => (
                  <button
                    key={s}
                    className={styles.suggestion}
                    onClick={() => void sendMessage(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <Message
                key={i}
                index={i}
                role={msg.role}
                content={msg.content}
                isError={msg.isError}
                pinned={msg.pinned}
                compactedCount={msg.compactedCount}
                isStreaming={
                  streaming && i === messages.length - 1 && msg.role === 'assistant'
                }
                onTogglePin={togglePin}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {compacting && (
          <div className={styles.compactingBar}>⚡ 正在压缩历史对话...</div>
        )}
        <ChatInput
          onSend={msg => void sendMessage(msg)}
          onStop={stopStreaming}
          streaming={streaming || compacting}
        />
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Delete old file**

```bash
rm packages/client/src/App.jsx
```

- [ ] **Step 3: Run tsc**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/App.tsx packages/client/src/App.jsx
git commit -m "feat(client): convert App component to TypeScript"
```

---

## Task 7: Convert entry point + config files

**Files:**
- Create: `packages/client/src/main.tsx`
- Delete: `packages/client/src/main.jsx`
- Rename: `packages/client/vite.config.js` → `packages/client/vite.config.ts`
- Modify: `packages/client/index.html`

- [ ] **Step 1: Create main.tsx**

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found in DOM')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 2: Delete main.jsx**

```bash
rm packages/client/src/main.jsx
```

- [ ] **Step 3: Rename vite.config.js → vite.config.ts**

```bash
mv packages/client/vite.config.js packages/client/vite.config.ts
```

Content is unchanged — Vite's `defineConfig` is already typed.

- [ ] **Step 4: Update index.html script src**

In `packages/client/index.html`, change:

```html
<script type="module" src="/src/main.jsx"></script>
```

to:

```html
<script type="module" src="/src/main.tsx"></script>
```

- [ ] **Step 5: Run tsc — full project clean**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0, zero errors, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/main.tsx packages/client/src/main.jsx \
        packages/client/vite.config.ts packages/client/vite.config.js \
        packages/client/index.html
git commit -m "feat(client): convert entry point and Vite config to TypeScript"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full type check**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 2: Production build**

```bash
cd packages/client && npm run build
```

Expected: `dist/` folder created, no TypeScript or Vite errors.

- [ ] **Step 3: Dev server smoke test**

```bash
npm run dev:client   # from repo root
```

Open http://localhost:5173, send a test message. Confirm streaming works, pin works, clear works.

- [ ] **Step 4: Verify no .jsx/.js files remain in src**

```bash
find packages/client/src -name "*.jsx" -o -name "*.js" | grep -v node_modules
```

Expected: no output.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(client): complete frontend TypeScript migration"
```

---

## Self-Review

**Spec coverage:**
- ✅ All 6 source files converted (useChat, Message, ChatInput, MemoryPanel, App, main)
- ✅ Config files converted (vite.config, tsconfig added)
- ✅ index.html updated
- ✅ Shared types centralised in types.ts
- ✅ strict mode enabled throughout

**Placeholder scan:** No TBDs, no "similar to task N", all code blocks complete.

**Type consistency:**
- `ChatMessage` used in useChat.ts, App.tsx, Message.tsx — consistent
- `MemoryNote` / `MemoryStore` used in MemoryPanel.tsx — consistent
- `UseChatReturn` defined in types.ts, returned by useChat.ts, consumed by App.tsx — consistent
- `MessageRole` used in ChatMessage.role and MessageProps.role — consistent
