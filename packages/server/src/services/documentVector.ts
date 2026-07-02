// packages/server/src/services/documentVector.ts
import { ChromaClient } from 'chromadb'
import { embedBatch, isEmbeddingAvailable, ZhipuEmbeddingFunction } from './embeddings.js'
import { RAG, candidatePool } from './ragConfig.js'
import { markDegraded } from './tracing.js'
import type { DocumentChunk } from '../types.js'

const LOG_RETRIEVAL = /^(1|true)$/i.test(process.env.LOG_RETRIEVAL ?? '')

/** 打印一次检索的候选块距离 + 阈值筛选结果（LOG_RETRIEVAL=1 开启）。 */
function logRetrieval(query: string, candidates: DocumentChunk[], kept: DocumentChunk[]): void {
  const keptIdx = new Set(kept.map(c => c.chunk_index))
  const rows = candidates
    .map(c => `    chunk_${c.chunk_index}  d=${c.distance.toFixed(4)}  ${keptIdx.has(c.chunk_index) ? '✓ 保留' : '✗ 丢弃'}`)
    .join('\n')
  console.error(
    `\n🔍 检索 [阈值≤${RAG.distanceThreshold} min=${RAG.minK} max=${RAG.maxK}]  q="${query.slice(0, 40)}"\n` +
      `  候选 ${candidates.length} → 保留 ${kept.length}\n${rows}`,
  )
}

const COLLECTION_NAME = 'docmind_docs'
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000'

// Infer Collection type from the client to avoid chromadb named-export fragility
type ChromaCollection = Awaited<ReturnType<ChromaClient['getOrCreateCollection']>>

let _client: ChromaClient | null = null
let _collection: ChromaCollection | null = null
let _available = false

export async function initDocCollection(): Promise<void> {
  if (!isEmbeddingAvailable()) {
    console.warn('[documentVector] Embedding not available — document semantic search disabled')
    return
  }
  try {
    _client = new ChromaClient({ path: CHROMA_URL })
    _collection = await _client.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: new ZhipuEmbeddingFunction(),
    })
    _available = true
    console.info(`[documentVector] ChromaDB connected — collection "${COLLECTION_NAME}"`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] ChromaDB unavailable (${msg}) — document search disabled`)
  }
}

export function isDocVectorAvailable(): boolean {
  return _available
}

export async function upsertChunks(
  userId: string,
  docId: string,
  filename: string,
  chunks: string[],
): Promise<void> {
  if (!_available || !_collection || chunks.length === 0) return

  try {
    const embeddings = await embedBatch(chunks)
    const ids = chunks.map((_, i) => `${docId}_chunk_${i}`)
    const metadatas = chunks.map((_, i) => ({ doc_id: docId, filename, chunk_index: i, user_id: userId }))

    await _collection.upsert({
      ids,
      embeddings,
      documents: chunks,
      metadatas,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] upsertChunks failed: ${msg}`)
  }
}

/**
 * 语义检索：距离阈值 + 动态 k。
 *
 * 1. 从向量库粗筛一批候选（candidatePool 个，按距离升序）
 * 2. 只保留 cosine 距离 <= RAG.distanceThreshold 的块，最多 maxK 个
 * 3. 若通过阈值的不足 minK，兜底取最近的 minK 个（minK=0 时可返回空 → 拒答）
 *
 * maxK 默认取环境配置 RAG.maxK；调用方仍可显式传入覆盖。
 */
export async function searchChunks(
  query: string,
  docIds: string[],
  maxK = RAG.maxK,
  userId?: string,
): Promise<DocumentChunk[]> {
  if (!_available || !_collection || docIds.length === 0) return []

  try {
    const queryEmbedding = (await embedBatch([query]))[0]
    const docFilter = docIds.length === 1
      ? { doc_id: { $eq: docIds[0] } }
      : { doc_id: { $in: docIds } }
    // When a userId is given, also require it — so one user can never retrieve
    // another user's chunks even if they pass a foreign doc_id.
    const where = userId
      ? { $and: [docFilter, { user_id: { $eq: userId } }] }
      : docFilter
    const results = await _collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: candidatePool(maxK),
      where,
    })

    const ids = results.ids[0] ?? []
    const documents = results.documents[0] ?? []
    const metadatas = results.metadatas[0] ?? []
    const distances = results.distances?.[0] ?? []

    // ChromaDB 按距离升序返回（最近的在前）
    const candidates: DocumentChunk[] = ids.map((_, i) => ({
      doc_id: String((metadatas[i] as Record<string, unknown>)?.doc_id ?? ''),
      filename: String((metadatas[i] as Record<string, unknown>)?.filename ?? ''),
      chunk_index: Number((metadatas[i] as Record<string, unknown>)?.chunk_index ?? 0),
      content: documents[i] ?? '',
      distance: distances[i] ?? 0,
    }))

    // 距离阈值 + 动态 k
    const within = candidates.filter(c => c.distance <= RAG.distanceThreshold)
    let kept = within.slice(0, maxK)
    if (kept.length < RAG.minK) {
      kept = candidates.slice(0, RAG.minK)
      markDegraded('doc_retrieval_minK', {
        threshold: RAG.distanceThreshold,
        topDistance: candidates[0]?.distance ?? null,
      })
    }

    if (LOG_RETRIEVAL) logRetrieval(query, candidates, kept)
    return kept
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] searchChunks failed: ${msg}`)
    return []
  }
}

export async function deleteByDocId(docId: string): Promise<void> {
  if (!_available || !_collection) return
  try {
    await _collection.delete({ where: { doc_id: { $eq: docId } } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] deleteByDocId failed: ${msg}`)
  }
}

/**
 * 取出某文档的所有 chunk（按 chunk_index 排序），用于评估场景遍历所有块。
 */
export async function getAllChunksByDoc(docId: string): Promise<Array<{
  id: string
  chunk_index: number
  content: string
}>> {
  if (!_available || !_collection) return []
  try {
    const results = await _collection.get({
      where: { doc_id: { $eq: docId } },
      include: ['documents', 'metadatas'],
    })
    const ids = results.ids ?? []
    const documents = results.documents ?? []
    const metadatas = results.metadatas ?? []
    const chunks = ids.map((id, i) => ({
      id,
      chunk_index: Number((metadatas[i] as Record<string, unknown>)?.chunk_index ?? 0),
      content: documents[i] ?? '',
    }))
    return chunks.sort((a, b) => a.chunk_index - b.chunk_index)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[documentVector] getAllChunksByDoc failed: ${msg}`)
    return []
  }
}
