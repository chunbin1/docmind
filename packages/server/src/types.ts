// packages/server/src/types.ts

export type LLMProvider = 'anthropic' | 'zhipu'

export type MessageRole = 'user' | 'assistant'

/** A message as sent by the client in request bodies */
export interface LLMMessage {
  role: MessageRole
  content: string
  pinned?: boolean
}

export interface StreamChatOptions {
  messages: LLMMessage[]
  system?: string
  maxTokens?: number
}

/** A persisted memory note row from SQLite */
export interface MemoryNote {
  id: string
  content: string
  source: string
  created_at: string
  chroma_id?: string | null
}

/** Parsed output from the compact LLM prompt */
export interface ParsedCompact {
  summary: string
  facts: string[]
}

/** A persisted document row from SQLite */
export interface Document {
  id: string
  filename: string
  size_bytes: number
  chunk_count: number
  created_at: string
}

/** A chunk returned from ChromaDB semantic search */
export interface DocumentChunk {
  doc_id: string
  filename: string
  chunk_index: number
  content: string
  distance: number
}
