import { test, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useConversations } from './useConversations'
import type { Conversation } from '../types'

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

const list: Conversation[] = [
  { id: 'c1', title: '会话一', updated_at: '2026-07-05T10:00:00Z', message_count: 2, generating: false },
  { id: 'c2', title: '会话二', updated_at: '2026-07-05T09:00:00Z', message_count: 0, generating: false },
]

test('加载：拉列表并默认选中第一条（最近）', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.conversations.map(c => c.id)).toEqual(['c1', 'c2'])
  expect(result.current.currentId).toBe('c1')
})

test('恢复 localStorage 选中；失效则回落最近', async () => {
  localStorage.setItem('docmind:currentConv:u1', 'c2')
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.currentId).toBe('c2'))
})

test('newConversation 置 currentId=null（草稿）', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.currentId).toBe('c1'))
  act(() => { result.current.newConversation() })
  expect(result.current.currentId).toBe(null)
})

test('onConversationCreated 乐观插入并设为当前', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ conversations: list })))
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => { result.current.onConversationCreated('c-new') })
  expect(result.current.currentId).toBe('c-new')
  expect(result.current.conversations[0].id).toBe('c-new')
})

test('deleteConversation 删当前时选下一条', async () => {
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
    if (opts?.method === 'DELETE') return jsonRes({ ok: true })
    return jsonRes({ conversations: list })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { result } = renderHook(() => useConversations('u1'))
  await waitFor(() => expect(result.current.currentId).toBe('c1'))
  act(() => { result.current.deleteConversation('c1') })
  expect(result.current.conversations.some(c => c.id === 'c1')).toBe(false)
  expect(result.current.currentId).toBe('c2')
})

test('并发防护：userId 切换后，旧账号飞行中的 fetchList 结果不得覆盖新账号已加载的会话', async () => {
  // u1 首拉挂起（不会立刻 resolve）。在其挂起期间切到 u2，u2 首拉立即 resolve。
  // 之后放行 u1 的挂起请求 resolve —— 断言最终 conversations/currentId 必须是 u2 的内容，
  // 而不是被 u1 的迟到响应覆盖。
  const u1List: Conversation[] = [
    { id: 'u1-a', title: 'u1 会话（不应出现）', updated_at: '2026-07-05T10:00:00Z', message_count: 1, generating: false },
  ]
  const u2List: Conversation[] = [
    { id: 'u2-a', title: 'u2 会话', updated_at: '2026-07-05T11:00:00Z', message_count: 1, generating: false },
  ]

  let resolveU1: ((v: Response) => void) | null = null
  const u1Gate = new Promise<Response>(resolve => { resolveU1 = resolve })

  // 按"当前生效的 userId"路由 mock 响应，而不是按全局调用序号：
  // - u1 的请求永远挂起在 u1Gate 上（测试放行一次即可，命中就是延迟到位的旧结果）
  // - u2 的请求永远立即返回 done
  let activeUserId: 'u1' | 'u2' = 'u1'
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (activeUserId === 'u1') return u1Gate
    return jsonRes({ conversations: u2List })
  }))

  const { result, rerender } = renderHook(
    ({ userId }) => useConversations(userId),
    { initialProps: { userId: 'u1' as string | null } },
  )

  // u1 首拉仍挂起中：loading 应为 true。
  expect(result.current.loading).toBe(true)

  // 切换到 u2：新的加载 effect 应该启动，且不再受旧 run（挂起的 u1 请求）影响。
  activeUserId = 'u2'
  rerender({ userId: 'u2' })

  // 等待 u2 首拉完成。
  await waitFor(() => expect(result.current.currentId).toBe('u2-a'))
  expect(result.current.conversations.map(c => c.id)).toEqual(['u2-a'])

  // 现在放行 u1 挂起的请求 resolve 出 u1List —— 此时组件已切到 u2。
  resolveU1?.(jsonRes({ conversations: u1List }))
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })

  // 断言：conversations/currentId 仍然是 u2 的内容，未被 u1 的迟到响应覆盖。
  expect(result.current.conversations.map(c => c.id)).toEqual(['u2-a'])
  expect(result.current.currentId).toBe('u2-a')
})
