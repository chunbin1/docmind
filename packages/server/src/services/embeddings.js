/**
 * Embedding service — wraps Zhipu embedding-3 (OpenAI-compatible).
 * Falls back gracefully when ZHIPU_API_KEY is not set.
 */

import OpenAI from 'openai'

let _client = null

function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.ZHIPU_API_KEY,
      baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    })
  }
  return _client
}

export function isEmbeddingAvailable() {
  return Boolean(process.env.ZHIPU_API_KEY)
}

/**
 * Embed a single text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const res = await getClient().embeddings.create({
    model: process.env.ZHIPU_EMBEDDING_MODEL || 'embedding-3',
    input: text,
  })
  return res.data[0].embedding
}

/**
 * Embed multiple texts in one API call.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts) {
  if (texts.length === 0) return []
  const res = await getClient().embeddings.create({
    model: process.env.ZHIPU_EMBEDDING_MODEL || 'embedding-3',
    input: texts,
  })
  return res.data.map(d => d.embedding)
}
