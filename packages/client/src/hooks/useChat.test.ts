import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatMessage } from '../types'

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

afterEach(() => { vi.unstubAllGlobals() })

test('加载：挂载时从 GET /messages 填充', async () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: '你好', status: 'done' },
    { id: 'm2', role: 'assistant', content: '你也好', status: 'done' },
  ]
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ messages })))

  const { result } = renderHook(() => useChat('u1'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.messages.map(m => m.content)).toEqual(['你好', '你也好'])
})

test('轮询恢复：末条 generating → 轮询到 done 后停止并显示完整答案', async () => {
  const gen: ChatMessage[] = [
    { id: 'u', role: 'user', content: '广州天气如何', status: 'done' },
    { id: 'a', role: 'assistant', content: '', status: 'generating' },
  ]
  const done: ChatMessage[] = [
    { id: 'u', role: 'user', content: '广州天气如何', status: 'done' },
    { id: 'a', role: 'assistant', content: '广州今天晴', status: 'done' },
  ]
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1
    return jsonRes({ messages: calls === 1 ? gen : done })
  }))

  const { result } = renderHook(() => useChat('u1'))
  await waitFor(() =>
    expect(result.current.messages.some(m => m.content === '广州今天晴')).toBe(true),
    { timeout: 3000 },
  )
})

test('加载失败：GET 出错时 loadError=true 且消息为空', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
  const { result } = renderHook(() => useChat('u1'))
  await waitFor(() => expect(result.current.loadError).toBe(true))
  expect(result.current.messages).toEqual([])
})
