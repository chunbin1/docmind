// packages/server/src/services/memoryVector.ts
import { ChromaClient, type EmbeddingFunction } from 'chromadb'
import { embed, embedBatch, isEmbeddingAvailable } from './embeddings.js'
import type { MemoryNote } from '../types.js'

const COLLECTION_NAME = 'docmind_memory'
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000'

// Custom embedding function using Zhipu API
class ZhipuEmbeddingFunction implements EmbeddingFunction {
  name = 'zhipu'

  async generate(texts: string[]): Promise<number[][]> {
    return embedBatch(texts)
  }

  defaultSpace() {
    return 'cosine' as const
  }

  supportedSpaces() {
    return ['cosine', 'l2', 'ip'] as const
  }
}

// Infer Collection type from the client to avoid chromadb named-export fragility
type ChromaCollection = Awaited<ReturnType<ChromaClient['getOrCreateCollection']>>

let _client: ChromaClient | null = null
let _collection: ChromaCollection | null = null
let _available = false

export async function initCollection(): Promise<void> {
  if (!isEmbeddingAvailable()) {
    console.warn('[memoryVector] ZHIPU_API_KEY not set — ChromaDB memory disabled, using FTS5 fallback')
    return
  }
  try {
    _client = new ChromaClient({ path: CHROMA_URL })
    _collection = await _client.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: new ZhipuEmbeddingFunction(),
    })
    _available = true
    console.info(`[memoryVector] ChromaDB connected — collection "${COLLECTION_NAME}"`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] ChromaDB unavailable (${msg}) — FTS5 fallback active`)
  }
}

export function isVectorAvailable(): boolean {
  return _available
}

export async function upsertNote(note: MemoryNote): Promise<void> {
  if (!_available || !_collection) return
  try {
    const vector = await embed(note.content)
    await _collection.upsert({
      ids: [note.id],
      embeddings: [vector],
      documents: [note.content],
      metadatas: [{ source: note.source, created_at: note.created_at }],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] upsertNote failed: ${msg}`)
  }
}

export async function deleteNoteVector(id: string): Promise<void> {
  if (!_available || !_collection) return
  try {
    await _collection.delete({ ids: [id] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] deleteNoteVector failed: ${msg}`)
  }
}

export async function semanticSearch(query: string, topK = 3): Promise<MemoryNote[]> {
  if (!_available || !_collection || !query?.trim()) return []
  try {
    const vector = await embed(query)
    const results = await _collection.query({
      queryEmbeddings: [vector],
      nResults: topK,
    })
    const ids = results.ids[0] ?? []
    const docs = results.documents[0] ?? []
    const metas = results.metadatas[0] ?? []
    return ids.map((id, i) => ({
      id,
      content: docs[i] ?? '',
      source: String(metas[i]?.source ?? 'unknown'),
      created_at: String(metas[i]?.created_at ?? ''),
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] semanticSearch failed: ${msg}`)
    return []
  }
}

export async function clearCollection(): Promise<void> {
  if (!_available || !_client) return
  try {
    await _client.deleteCollection({ name: COLLECTION_NAME })
    _collection = await _client.getOrCreateCollection({ name: COLLECTION_NAME })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memoryVector] clearCollection failed: ${msg}`)
  }
}
