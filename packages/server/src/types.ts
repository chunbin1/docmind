// packages/server/src/types.ts

export type LLMProvider = 'anthropic' | 'zhipu'

export type MessageRole = 'user' | 'assistant'

/** A message as sent by the client in request bodies */
export interface LLMMessage {
  role: MessageRole
  content: string
}

export interface StreamChatOptions {
  messages: LLMMessage[]
  system?: string
  maxTokens?: number
  /** 日志标签，标识调用来源（如 chat/stream、chat/compact）；仅用于 LOG_LLM 调试输出 */
  tag?: string
  /** 取消信号：abort 后底层 SDK 请求会中断，用于「停止生成」。 */
  signal?: AbortSignal
  /** 推理模型的思考内容（reasoning_content）回调；不设则丢弃。 */
  onReasoning?: (delta: string) => void
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

// =============================================================================
// Evaluation types
//
// Domain types for the RAG evaluation module. Interface fields mirror SQLite
// row shapes (snake_case). EvalConfigSnapshot is the deserialized form of
// EvalRun.config_snapshot — stored as a JSON string in the row, parsed at the
// service layer; its keys use camelCase because it represents a logical config
// object, not a DB row.
// =============================================================================

export type EvalDifficulty = 'easy' | 'medium' | 'hard'
export type EvalRunStatus = 'running' | 'done' | 'failed'

export interface EvalTestSet {
  id: string
  doc_id: string
  name: string
  case_count: number  // denormalized count of related eval_cases rows
  created_at: string
  user_id?: string    // owner; scopes test sets per user
}

export interface EvalCase {
  id: string
  test_set_id: string
  question: string
  expected_answer: string
  ground_truth_chunk_id: string
  difficulty: EvalDifficulty
}

export interface EvalConfigSnapshot {
  chunkSize: number
  overlap: number
  topK: number          // retrieval cap (= RAG.maxK under dynamic-k retrieval)
  distanceThreshold?: number  // cosine distance cutoff; absent for pre-dynamic-k runs
  minK?: number               // floor on returned chunks; absent for pre-dynamic-k runs
  model: string         // model used in the RAG pipeline (answer generation)
  embedModel: string
  judgeModel: string    // model used by LLM-as-Judge for scoring (defaults to glm-4.7)
}

export interface EvalRun {
  id: string
  test_set_id: string
  config_snapshot: string  // JSON string of EvalConfigSnapshot
  status: EvalRunStatus
  started_at: string
  finished_at: string | null
  avg_context_recall: number | null
  avg_context_precision: number | null
  avg_faithfulness: number | null
  avg_answer_relevancy: number | null
  total_tokens: number | null  // sum of all LLM token usage in this run (NULL for pre-tracking runs)
}

export interface EvalResult {
  id: string
  run_id: string
  case_id: string
  retrieved_chunk_ids: string  // JSON array of strings
  generated_answer: string
  context_recall: number | null
  context_precision: number | null
  faithfulness: number | null
  answer_relevancy: number | null
  judge_reasoning: string | null  // JSON: { precision: string, faithfulness: string, relevancy: string }
  prompt_tokens: number | null      // input tokens (answer-gen + judge), NULL for pre-tracking results
  completion_tokens: number | null  // output tokens
  total_tokens: number | null       // prompt + completion
}
