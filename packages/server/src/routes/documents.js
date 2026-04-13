/**
 * Document routes — 里程碑 2 实现
 * POST /api/documents/upload  上传并处理文档
 * GET  /api/documents          列出所有文档
 * DELETE /api/documents/:id    删除文档
 */
export async function documentRoutes(app) {
  app.get('/documents', async () => {
    return { documents: [], message: 'Coming in milestone 2' }
  })
}
