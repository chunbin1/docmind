import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
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

test('并发防护：userId 切换后，旧账号飞行中的轮询结果不得覆盖新账号已加载的消息', async () => {
  // u1 首拉返回 generating，从而启动轮询；轮询请求被挂起（不会立刻 resolve）。
  // 在轮询挂起期间切到 u2，u2 首拉立即返回 done 消息。
  // 之后放行 u1 的挂起轮询 resolve —— 断言最终 messages 必须是 u2 的内容，而不是被 u1 的轮询结果覆盖。
  const u1Gen: ChatMessage[] = [
    { id: 'u1-a', role: 'user', content: 'u1 的问题', status: 'done' },
    { id: 'u1-b', role: 'assistant', content: '', status: 'generating' },
  ]
  const u1Done: ChatMessage[] = [
    { id: 'u1-a', role: 'user', content: 'u1 的问题', status: 'done' },
    { id: 'u1-b', role: 'assistant', content: 'u1 的答案（不应出现）', status: 'done' },
  ]
  const u2Done: ChatMessage[] = [
    { id: 'u2-a', role: 'user', content: 'u2 的问题', status: 'done' },
    { id: 'u2-b', role: 'assistant', content: 'u2 的答案', status: 'done' },
  ]

  let resolveU1Poll: ((v: Response) => void) | null = null
  const u1PollGate = new Promise<Response>(resolve => { resolveU1Poll = resolve })

  // 按"当前生效的 userId"路由 mock 响应，而不是按全局调用序号——
  // 这样无论 effect/轮询的调用时机如何交错，行为都是确定的：
  // - u1 处于 pending（尚未 resolve u1PollGate）时，所有对 u1 的请求在首次之后都会挂起
  //   （首次给 generating，之后的轮询请求全部挂起在同一个 gate 上，测试只需放行一次）
  // - u2 的请求永远立即返回 done
  let activeUserId: 'u1' | 'u2' = 'u1'
  let u1CallCount = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (activeUserId === 'u1') {
      u1CallCount += 1
      if (u1CallCount === 1) return jsonRes({ messages: u1Gen })
      return u1PollGate
    }
    return jsonRes({ messages: u2Done })
  }))

  const { result, rerender } = renderHook(({ userId }) => useChat(userId), {
    initialProps: { userId: 'u1' as string | null },
  })

  // 等待 u1 首拉完成并进入 generating 状态（轮询已排入 setTimeout）。
  await waitFor(() => expect(result.current.messages.some(m => m.id === 'u1-b')).toBe(true))

  // 推进真实定时器，让 u1 的第一次轮询回调真正触发并挂起在 u1PollGate 上。
  await act(async () => { await new Promise(r => setTimeout(r, 1100)) })
  expect(u1CallCount).toBeGreaterThanOrEqual(2)

  // 切换到 u2：新的加载 effect 应该启动，且不再受旧 run（挂起的 u1 轮询）影响。
  activeUserId = 'u2'
  rerender({ userId: 'u2' })

  // 等待 u2 首拉完成。
  await waitFor(() => expect(result.current.messages.some(m => m.id === 'u2-b')).toBe(true))
  expect(result.current.messages.map(m => m.content)).toEqual(['u2 的问题', 'u2 的答案'])

  // 现在放行 u1 挂起的轮询 fetch，让它 resolve 出 u1Done——此时组件已切到 u2。
  resolveU1Poll?.(jsonRes({ messages: u1Done }))
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })

  // 断言：messages 仍然是 u2 的内容，未被 u1 的迟到轮询结果覆盖。
  expect(result.current.messages.map(m => m.content)).toEqual(['u2 的问题', 'u2 的答案'])
})

test('卸载防护：unmount 后飞行中的轮询回调不再触发 setState（无报错/警告）', async () => {
  const gen: ChatMessage[] = [
    { id: 'u', role: 'user', content: '提问', status: 'done' },
    { id: 'a', role: 'assistant', content: '', status: 'generating' },
  ]
  const done: ChatMessage[] = [
    { id: 'u', role: 'user', content: '提问', status: 'done' },
    { id: 'a', role: 'assistant', content: '完整答案', status: 'done' },
  ]
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1
    return jsonRes({ messages: calls === 1 ? gen : done })
  }))
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  const { result, unmount } = renderHook(() => useChat('u1'))
  await waitFor(() => expect(result.current.messages.some(m => m.id === 'a' && m.status === 'generating')).toBe(true))

  unmount()

  // 推进超过一个轮询间隔，让已排入的轮询回调真正执行并 await fetch。
  await act(async () => { await new Promise(r => setTimeout(r, 1200)) })

  expect(errorSpy).not.toHaveBeenCalled()
  errorSpy.mockRestore()
})
