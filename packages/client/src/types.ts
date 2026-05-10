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
  sendMessage: (message: string, systemPrompt?: string, docIds?: string[]) => Promise<void>
  stopStreaming: () => void
  clearMessages: () => void
  togglePin: (index: number) => void
}

/** A persisted document available for attachment */
export interface Document {
  id: string
  filename: string
  size_bytes: number
  chunk_count: number
  created_at: string
}
