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
import { currentUser } from './auth.js'

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
  app.get('/memory', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const notes = getAllNotes(user.id)
    const totalChars = getTotalChars(user.id)
    return { notes, totalChars, maxChars: MAX_CHARS, vectorEnabled: isVectorAvailable() }
  })

  app.post<{ Body: AddNotesBody }>('/memory/notes', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const { notes: contents, source = 'manual' } = request.body ?? {}
    if (!Array.isArray(contents) || contents.length === 0) {
      return reply.status(400).send({ error: 'notes array required' })
    }
    const saved = addNotes(user.id, contents, source)
    for (const note of saved) {
      upsertNote(user.id, note).catch(() => {})
    }
    return { saved, totalChars: getTotalChars(user.id) }
  })

  app.post<{ Body: SearchBody }>('/memory/search', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const { query, topK = 5 } = request.body ?? {}
    if (!query || typeof query !== 'string') {
      return reply.status(400).send({ error: 'query string required' })
    }
    let results = await semanticSearch(user.id, query, topK)
    if (results.length === 0) results = searchFts(user.id, query, topK)
    return { results, vectorUsed: isVectorAvailable() && results.length > 0 }
  })

  app.delete<{ Params: NoteParams }>('/memory/notes/:id', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    const { id } = request.params
    deleteNote(user.id, id)
    deleteNoteVector(id).catch(() => {})
    return { ok: true }
  })

  app.delete('/memory', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    clearAll(user.id)
    clearCollection(user.id).catch(() => {})
    return { ok: true }
  })
}
