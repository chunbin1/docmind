import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatMessage } from '../types'

// 复现用户报的完整场景：发送 → 刷新（卸载再挂载）→ 消息应仍在界面上
test('发送后刷新（重新挂载）应恢复用户消息', async () => {
  const { res, push, close } = sseResponse()
  vi.stubGlobal('fetch', vi.fn(async () => res))

  const first = renderHook(() => useChat('u1'))
  let sendPromise!: Promise<void>
  await act(async () => {
    sendPromise = first.result.current.sendMessage('刷新前发的消息')
    await new Promise(r => setTimeout(r, 0))
  })
  await act(async () => {
    push({ text: '部分回答' })
    await new Promise(r => setTimeout(r, 0))
  })

  // 模拟刷新：卸载当前 hook，重新挂载一份新的（读同一 localStorage）
  first.unmount()
  const second = renderHook(() => useChat('u1'))
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })

  expect(
    second.result.current.messages.some(
      m => m.role === 'user' && m.content === '刷新前发的消息',
    ),
  ).toBe(true)

  await act(async () => { push({ done: true }); close(); await sendPromise })
})

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

// 用户刷新时 AI 还没开始输出，持久化里留下一个空的 assistant 占位；
// 加载后不应把这个空气泡显示出来（它永远不会再填内容，看起来像坏了）。
test('刷新后应丢弃空的 AI 占位气泡，但保留用户消息', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { role: 'user', content: '南京的天气怎么样' },
    { role: 'assistant', content: '' },
  ]))

  const { result } = renderHook(() => useChat('u1'))
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })

  expect(
    result.current.messages.some(m => m.role === 'user' && m.content === '南京的天气怎么样'),
  ).toBe(true)
  expect(
    result.current.messages.some(m => m.role === 'assistant' && m.content.trim() === ''),
  ).toBe(false)
})

// 已收到部分回答的中断消息应保留（比空气泡有价值）。
test('刷新后保留已收到部分内容的 AI 回答', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { role: 'user', content: '南京的天气怎么样' },
    { role: 'assistant', content: '南京今天' },
  ]))

  const { result } = renderHook(() => useChat('u1'))
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })

  expect(
    result.current.messages.some(m => m.role === 'assistant' && m.content === '南京今天'),
  ).toBe(true)
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
