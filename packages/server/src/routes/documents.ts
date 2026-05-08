// packages/server/src/routes/documents.ts
import type { FastifyPluginAsync } from 'fastify'

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/documents', async () => {
    return { documents: [], message: 'Coming in milestone 2' }
  })
}
