// packages/server/src/routes/memory.ts
import type { FastifyPluginAsync } from 'fastify'
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

interface AddNotesBody {
  notes: string[]
  source?: string
}

interface SearchBody {
  query: string
  topK?: number
}

interface NoteParams {
  id: string
}

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/memory', async () => {
    const notes = getAllNotes()
    const totalChars = getTotalChars()
    return { notes, totalChars, maxChars: MAX_CHARS, vectorEnabled: isVectorAvailable() }
  })

  app.post<{ Body: AddNotesBody }>('/memory/notes', async (request, reply) => {
    const { notes: contents, source = 'manual' } = request.body ?? {}
    if (!Array.isArray(contents) || contents.length === 0) {
      return reply.status(400).send({ error: 'notes array required' })
    }
    const saved = addNotes(contents, source)
    for (const note of saved) {
      upsertNote(note).catch(() => {})
    }
    return { saved, totalChars: getTotalChars() }
  })

  app.post<{ Body: SearchBody }>('/memory/search', async (request, reply) => {
    const { query, topK = 5 } = request.body ?? {}
    if (!query || typeof query !== 'string') {
      return reply.status(400).send({ error: 'query string required' })
    }
    let results = await semanticSearch(query, topK)
    if (results.length === 0) results = searchFts(query, topK)
    return { results, vectorUsed: isVectorAvailable() && results.length > 0 }
  })

  app.delete<{ Params: NoteParams }>('/memory/notes/:id', async (request) => {
    const { id } = request.params
    deleteNote(id)
    deleteNoteVector(id).catch(() => {})
    return { ok: true }
  })

  app.delete('/memory', async () => {
    clearAll()
    clearCollection().catch(() => {})
    return { ok: true }
  })
}
