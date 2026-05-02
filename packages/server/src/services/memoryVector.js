/**
 * Memory Vector Store — ChromaDB-backed semantic search for memory notes.
 *
 * Collection: "docmind_memory"
 * Embedding: Zhipu embedding-3 via embeddings.js
 *
 * Degrades gracefully:
 *   - ChromaDB unreachable → logs warning, all operations no-op
 *   - ZHIPU_API_KEY missing → skips upsert, semanticSearch returns []
 */

import { ChromaClient } from 'chromadb'
import { embed, isEmbeddingAvailable } from './embeddings.js'

const COLLECTION_NAME = 'docmind_memory'
const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000'

let _client = null
let _collection = null
let _available = false

export async function initCollection() {
  if (!isEmbeddingAvailable()) {
    console.warn('[memoryVector] ZHIPU_API_KEY not set — ChromaDB memory disabled, using FTS5 fallback')
    return
  }
  try {
    _client = new ChromaClient({ path: CHROMA_URL })
    _collection = await _client.getOrCreateCollection({ name: COLLECTION_NAME })
    _available = true
    console.info(`[memoryVector] ChromaDB connected — collection "${COLLECTION_NAME}"`)
  } catch (err) {
    console.warn(`[memoryVector] ChromaDB unavailable (${err.message}) — FTS5 fallback active`)
  }
}

export function isVectorAvailable() {
  return _available
}

/**
 * Embed a note and upsert into ChromaDB.
 * @param {{ id: string, content: string, source: string, created_at: string }} note
 */
export async function upsertNote(note) {
  if (!_available) return
  try {
    const vector = await embed(note.content)
    await _collection.upsert({
      ids: [note.id],
      embeddings: [vector],
      documents: [note.content],
      metadatas: [{ source: note.source, created_at: note.created_at }],
    })
  } catch (err) {
    console.warn(`[memoryVector] upsertNote failed: ${err.message}`)
  }
}

/**
 * Delete a note vector from ChromaDB.
 */
export async function deleteNoteVector(id) {
  if (!_available) return
  try {
    await _collection.delete({ ids: [id] })
  } catch (err) {
    console.warn(`[memoryVector] deleteNoteVector failed: ${err.message}`)
  }
}

/**
 * Semantic search: embed query and return top-k relevant notes.
 * Returns [] when ChromaDB is unavailable.
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<{ id: string, content: string, source: string, created_at: string }[]>}
 */
export async function semanticSearch(query, topK = 3) {
  if (!_available || !query?.trim()) return []
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
      content: docs[i],
      source: metas[i]?.source ?? 'unknown',
      created_at: metas[i]?.created_at ?? '',
    }))
  } catch (err) {
    console.warn(`[memoryVector] semanticSearch failed: ${err.message}`)
    return []
  }
}

/**
 * Clear all vectors in the collection.
 */
export async function clearCollection() {
  if (!_available) return
  try {
    await _client.deleteCollection({ name: COLLECTION_NAME })
    _collection = await _client.getOrCreateCollection({ name: COLLECTION_NAME })
  } catch (err) {
    console.warn(`[memoryVector] clearCollection failed: ${err.message}`)
  }
}
