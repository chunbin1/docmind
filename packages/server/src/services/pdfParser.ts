// packages/server/src/services/pdfParser.ts
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface ParseError {
  code: 'TOO_LARGE' | 'EMPTY_TEXT' | 'PARSE_FAILED'
  message: string
}

export interface ParseResult {
  text: string
  pages: number
}

export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  if (buffer.length > MAX_FILE_BYTES) {
    throw { code: 'TOO_LARGE', message: '文件超过 10MB 限制' } satisfies ParseError
  }

  let result: { text: string; numpages: number }
  try {
    result = await pdfParse(buffer)
  } catch {
    throw { code: 'PARSE_FAILED', message: 'PDF 解析失败，可能是加密或损坏文件' } satisfies ParseError
  }

  const text = result.text.trim()
  if (!text) {
    throw { code: 'EMPTY_TEXT', message: '该 PDF 为扫描件，暂不支持' } satisfies ParseError
  }

  return { text, pages: result.numpages }
}

export interface ChunkOptions {
  chunkSize?: number
  overlap?: number
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const { chunkSize = 500, overlap = 50 } = opts
  const separators = ['\n\n', '\n', ' ', '']
  return recursiveSplit(text, separators, chunkSize, overlap)
}

function recursiveSplit(
  text: string,
  separators: string[],
  chunkSize: number,
  overlap: number,
): string[] {
  if (text.length <= chunkSize) return text.trim() ? [text.trim()] : []

  const [sep, ...rest] = separators

  // No separator left — hard split by character
  if (sep === undefined) {
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize))
      start += chunkSize - overlap
    }
    return chunks
  }

  const parts = sep ? text.split(sep) : text.split('')

  // If this separator doesn't split the text, try next
  if (parts.length === 1) return recursiveSplit(text, rest, chunkSize, overlap)

  const chunks: string[] = []
  let current = ''

  for (const part of parts) {
    const candidate = current ? current + sep + part : part
    if (candidate.length <= chunkSize) {
      current = candidate
    } else {
      if (current.trim()) chunks.push(current.trim())
      // If a single part is too long, recurse with finer separators
      if (part.length > chunkSize) {
        chunks.push(...recursiveSplit(part, rest, chunkSize, overlap))
        current = ''
      } else {
        current = part
      }
    }
  }
  if (current.trim()) chunks.push(current.trim())

  // Apply overlap: prepend tail of previous chunk to next
  if (overlap > 0 && chunks.length > 1) {
    return chunks.map((chunk, i) => {
      if (i === 0) return chunk
      const prev = chunks[i - 1]
      const tail = prev.slice(-overlap)
      return (tail + ' ' + chunk).trim()
    })
  }

  return chunks
}
