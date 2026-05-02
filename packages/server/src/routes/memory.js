/**
 * Memory REST API
 *
 * GET  /api/memory              — list all notes + stats
 * POST /api/memory/notes        — add notes (bulk)
 * POST /api/memory/search       — semantic or FTS keyword search
 * DELETE /api/memory/notes/:id  — delete single note
 * DELETE /api/memory            — clear all notes
 */

import {
  addNotes,
  deleteNote,
  clearAll,
  getAllNotes,
  searchFts,
  getTotalChars,
} from '../services/memoryStore.js'
import {
  upsertNote,
  deleteNoteVector,
  clearCollection,
  semanticSearch,
  isVectorAvailable,
} from '../services/memoryVector.js'

const MAX_CHARS = 20000

export async function memoryRoutes(app) {
  // GET /api/memory
  app.get('/memory', async () => {
    const notes = getAllNotes()
    const totalChars = getTotalChars()
    return { notes, totalChars, maxChars: MAX_CHARS, vectorEnabled: isVectorAvailable() }
  })

  // POST /api/memory/notes
  app.post('/memory/notes', async (request, reply) => {
    const { notes: contents, source = 'manual' } = request.body ?? {}
    if (!Array.isArray(contents) || contents.length === 0) {
      return reply.status(400).send({ error: 'notes array required' })
    }
    const saved = addNotes(contents, source)
    // Async upsert into ChromaDB (fire-and-forget, non-blocking)
    for (const note of saved) {
      upsertNote(note).catch(() => {})
    }
    return { saved, totalChars: getTotalChars() }
  })

  // POST /api/memory/search
  app.post('/memory/search', async (request, reply) => {
    const { query, topK = 5 } = request.body ?? {}
    if (!query || typeof query !== 'string') {
      return reply.status(400).send({ error: 'query string required' })
    }
    // Try semantic search; fall back to FTS5
    let results = await semanticSearch(query, topK)
    if (results.length === 0) {
      results = searchFts(query, topK)
    }
    return { results, vectorUsed: isVectorAvailable() && results.length > 0 }
  })

  // DELETE /api/memory/notes/:id
  app.delete('/memory/notes/:id', async (request) => {
    const { id } = request.params
    deleteNote(id)
    deleteNoteVector(id).catch(() => {})
    return { ok: true }
  })

  // DELETE /api/memory  (clear all)
  app.delete('/memory', async () => {
    clearAll()
    clearCollection().catch(() => {})
    return { ok: true }
  })
}
