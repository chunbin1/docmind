// packages/server/src/services/embeddings.ts
import { type EmbeddingFunction, type EmbeddingFunctionSpace } from 'chromadb'

const BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

export function isEmbeddingAvailable(): boolean {
  if (process.env.DISABLE_EMBEDDING === 'true') return false
  return Boolean(process.env.ZHIPU_API_KEY)
}

async function callEmbeddingAPI(input: string | string[]): Promise<number[][]> {
  const model = process.env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3'
  const apiKey = process.env.ZHIPU_API_KEY

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
  return data.data.map(d => d.embedding)
}

export async function embed(text: string): Promise<number[]> {
  const result = await callEmbeddingAPI(text)
  return result[0]
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  return callEmbeddingAPI(texts)
}

export class ZhipuEmbeddingFunction implements EmbeddingFunction {
  name = 'zhipu'

  async generate(texts: string[]): Promise<number[][]> {
    return embedBatch(texts)
  }

  defaultSpace() {
    return 'cosine' as const
  }

  supportedSpaces(): EmbeddingFunctionSpace[] {
    return ['cosine', 'l2', 'ip']
  }
}
