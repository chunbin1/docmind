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

// === Evaluation types ===

export type EvalDifficulty = 'easy' | 'medium' | 'hard'
export type EvalRunStatus = 'running' | 'done' | 'failed'

export interface EvalTestSet {
  id: string
  doc_id: string
  name: string
  case_count: number
  created_at: string
}

export interface EvalCase {
  id: string
  test_set_id: string
  question: string
  expected_answer: string
  ground_truth_chunk_id: string
  difficulty: EvalDifficulty
}

export interface EvalRun {
  id: string
  test_set_id: string
  config_snapshot: string
  status: EvalRunStatus
  started_at: string
  finished_at: string | null
  avg_context_recall: number | null
  avg_context_precision: number | null
  avg_faithfulness: number | null
  avg_answer_relevancy: number | null
}

export interface EvalResult {
  id: string
  run_id: string
  case_id: string
  retrieved_chunk_ids: string
  generated_answer: string
  context_recall: number | null
  context_precision: number | null
  faithfulness: number | null
  answer_relevancy: number | null
  judge_reasoning: string | null
}

/** A result joined with its source case (returned by GET /api/eval/runs/:id). */
export interface EvalResultWithCase extends EvalResult {
  question: string
  expected_answer: string
  difficulty: EvalDifficulty
}

// === Trace 可视化类型（对齐 server 端 tracing.ts）===

export type TraceStatus = 'ok' | 'degraded' | 'error'

/** GET /api/traces 列表项 / GET /api/traces/:id 的 trace 字段 */
export interface TraceRecord {
  id: string
  route: string
  user_id: string | null
  status: TraceStatus
  duration_ms: number
  span_count: number
  degraded_count: number
  error_count: number
  started_at: string
  created_at: string
}

/** GET /api/traces/:id 返回的单个 span */
export interface SpanRecord {
  id: string
  trace_id: string
  parent_span_id: string | null
  name: string
  status: TraceStatus
  start_offset_ms: number
  duration_ms: number
  degraded_reason: string | null
  input: string | null
  output: string | null
  /** JSON 字符串 */
  metadata: string
  error_message: string | null
}

/** buildWaterfall 的输出行 */
export interface WaterfallRow {
  span: SpanRecord
  depth: number
  leftPct: number
  widthPct: number
}
