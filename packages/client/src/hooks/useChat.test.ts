import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatMessage } from '../types'

const STORAGE_KEY = 'docmind:chat:u1'

/** 一个可手动推送/关闭的 SSE 响应，模拟仍在进行中的流 */
function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c },
  })
  const enc = new TextEncoder()
  return {
    res: { ok: true, status: 200, body } as unknown as Response,
    push: (obj: object) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)),
    close: () => controller.close(),
  }
}

function savedMessages(): ChatMessage[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as ChatMessage[]
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('流式进行中，已发送的用户消息就应写入 localStorage（刷新不丢）', async () => {
  const { res, push, close } = sseResponse()
  vi.stubGlobal('fetch', vi.fn(async () => res))

  const { result } = renderHook(() => useChat('u1'))

  let sendPromise!: Promise<void>
  await act(async () => {
    sendPromise = result.current.sendMessage('明天北京天气怎么样')
    await new Promise(r => setTimeout(r, 0))
  })

  // 回答尚未结束，此刻刷新页面只能看到 localStorage 里的内容
  expect(result.current.streaming).toBe(true)
  expect(
    savedMessages().some(m => m.role === 'user' && m.content === '明天北京天气怎么样'),
  ).toBe(true)

  // 收尾：推完流，等 sendMessage 正常返回
  await act(async () => {
    push({ text: '答案' })
    push({ done: true })
    close()
    await sendPromise
  })
})

test('流式进行中，已收到的部分回答也应写入 localStorage', async () => {
  const { res, push, close } = sseResponse()
  vi.stubGlobal('fetch', vi.fn(async () => res))

  const { result } = renderHook(() => useChat('u1'))

  let sendPromise!: Promise<void>
  await act(async () => {
    sendPromise = result.current.sendMessage('你好')
    await new Promise(r => setTimeout(r, 0))
  })
  await act(async () => {
    push({ text: '部分回答' })
    await new Promise(r => setTimeout(r, 0))
  })

  expect(result.current.streaming).toBe(true)
  expect(
    savedMessages().some(m => m.role === 'assistant' && m.content === '部分回答'),
  ).toBe(true)

  await act(async () => {
    push({ done: true })
    close()
    await sendPromise
  })
})

test('流结束后完整对话已持久化', async () => {
  const { res, push, close } = sseResponse()
  vi.stubGlobal('fetch', vi.fn(async () => res))

  const { result } = renderHook(() => useChat('u1'))

  await act(async () => {
    const p = result.current.sendMessage('你好')
    await new Promise(r => setTimeout(r, 0))
    push({ text: '完整回答' })
    push({ done: true })
    close()
    await p
  })

  expect(result.current.streaming).toBe(false)
  const saved = savedMessages()
  expect(saved.some(m => m.role === 'user' && m.content === '你好')).toBe(true)
  expect(saved.some(m => m.role === 'assistant' && m.content === '完整回答')).toBe(true)
})
