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
