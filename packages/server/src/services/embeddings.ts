// packages/server/src/services/embeddings.ts

const BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

export function isEmbeddingAvailable(): boolean {
  if (process.env.DISABLE_EMBEDDING === 'true') return false
  return Boolean(process.env.ZHIPU_API_KEY)
}

async function callEmbeddingAPI(input: string | string[]): Promise<number[][]> {
  const model = process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3'
  const apiKey = process.env.ZHIPU_API_KEY

  console.log(`[embeddings] Calling Zhipu API with model: ${model}`)
  console.log(`[embeddings] Input type: ${typeof input}, isArray: ${Array.isArray(input)}`)

  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Zhipu API error: ${res.status} ${text}`)
  }

  const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> }
  console.log(`[embeddings] API returned ${data.data.length} embeddings`)

  if (data.data.length > 0) {
    const first = data.data[0]
    console.log(`[embeddings] First embedding dimension: ${first.embedding.length}`)
    console.log(`[embeddings] First embedding sample: ${first.embedding.slice(0, 5)}`)
  }

  return data.data.map(d => d.embedding)
}

/**
 * Embed a single text string.
 */
export async function embed(text: string): Promise<number[]> {
  const result = await callEmbeddingAPI(text)
  return result[0]
}

/**
 * Embed multiple texts in one API call.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  return callEmbeddingAPI(texts)
}
