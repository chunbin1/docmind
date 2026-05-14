// packages/server/src/services/documentVector.ts
import { ChromaClient } from 'chromadb'
import { embedBatch, isEmbeddingAvailable, ZhipuEmbeddingFunction } from './embeddings.js'
import type { DocumentChunk } from '../types.js'

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
  docId: string,
  filename: string,
  chunks: string[],
): Promise<void> {
  if (!_available || !_collection || chunks.length === 0) return

  try {
    const embeddings = await embedBatch(chunks)
    const ids = chunks.map((_, i) => `${docId}_chunk_${i}`)
    const metadatas = chunks.map((_, i) => ({ doc_id: docId, filename, chunk_index: i }))

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

export async function searchChunks(
  query: string,
  docIds: string[],
  topK = 3,
): Promise<DocumentChunk[]> {
  if (!_available || !_collection || docIds.length === 0) return []

  try {
    const queryEmbedding = (await embedBatch([query]))[0]
    const results = await _collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where: docIds.length === 1
        ? { doc_id: { $eq: docIds[0] } }
        : { doc_id: { $in: docIds } },
    })

    const ids = results.ids[0] ?? []
    const documents = results.documents[0] ?? []
    const metadatas = results.metadatas[0] ?? []
    const distances = results.distances?.[0] ?? []

    return ids.map((_, i) => ({
      doc_id: String((metadatas[i] as Record<string, unknown>)?.doc_id ?? ''),
      filename: String((metadatas[i] as Record<string, unknown>)?.filename ?? ''),
      chunk_index: Number((metadatas[i] as Record<string, unknown>)?.chunk_index ?? 0),
      content: documents[i] ?? '',
      distance: distances[i] ?? 0,
    }))
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
