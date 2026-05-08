// packages/server/src/services/embeddings.ts
import OpenAI from 'openai'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.ZHIPU_API_KEY,
      baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    })
  }
  return _client
}

export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.ZHIPU_API_KEY)
}

/**
 * Embed a single text string.
 */
export async function embed(text: string): Promise<number[]> {
  const res = await getClient().embeddings.create({
    model: process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3',
    input: text,
  })
  return res.data[0].embedding
}

/**
 * Embed multiple texts in one API call.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const res = await getClient().embeddings.create({
    model: process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3',
    input: texts,
  })
  return res.data.map(d => d.embedding)
}
