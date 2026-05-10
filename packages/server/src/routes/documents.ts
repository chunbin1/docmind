// packages/server/src/routes/documents.ts
import type { FastifyPluginAsync } from 'fastify'
import { parsePdf, chunkText } from '../services/pdfParser.js'
import { saveDocument, getAllDocuments, deleteDocument, getDocument } from '../services/documentStore.js'
import { upsertChunks, deleteByDocId, isDocVectorAvailable } from '../services/documentVector.js'
import type { ParseError } from '../services/pdfParser.js'

function isParseError(e: unknown): e is ParseError {
  return typeof e === 'object' && e !== null && 'code' in e
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents — list all documents
  app.get('/documents', async () => {
    const documents = getAllDocuments()
    return { documents }
  })

  // POST /api/documents — upload a PDF
  app.post('/documents', async (request, reply) => {
    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' })
    }

    const mimetype = data.mimetype
    if (mimetype !== 'application/pdf') {
      return reply.status(400).send({ error: '只支持 PDF 文件' })
    }

    const buffer = await data.toBuffer()

    let parseResult: Awaited<ReturnType<typeof parsePdf>>
    try {
      parseResult = await parsePdf(buffer)
    } catch (err) {
      if (isParseError(err)) {
        const status = err.code === 'EMPTY_TEXT' ? 422 : 400
        return reply.status(status).send({ error: err.message })
      }
      return reply.status(500).send({ error: 'PDF 处理失败' })
    }

    const chunks = chunkText(parseResult.text)
    const doc = saveDocument({
      filename: data.filename,
      size_bytes: buffer.length,
      chunk_count: chunks.length,
    })

    if (isDocVectorAvailable()) {
      upsertChunks(doc.id, doc.filename, chunks).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        app.log.warn(`[documents] upsertChunks failed for ${doc.id}: ${msg}`)
      })
    }

    return { document: doc }
  })

  // DELETE /api/documents/:id
  app.delete<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    const { id } = request.params
    const doc = getDocument(id)
    if (!doc) {
      return reply.status(404).send({ error: 'Document not found' })
    }

    await deleteByDocId(id)
    deleteDocument(id)

    return { success: true }
  })
}
