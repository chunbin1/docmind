import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initChatTables, appendMessage, getMessages } from './chatStore.js'
import { streamAndPersist } from './chatGeneration.js'

function setup() {
  const db = new Database(':memory:')
  initChatTables(db)
  return db
}

async function* gen(chunks: string[]) {
  for (const c of chunks) yield c
}

test('客户端断开（send 抛错）仍把答案生成完并落库 done', async () => {
  const db = setup()
  const { id } = appendMessage('u1', { role: 'assistant', content: '', status: 'generating' })
  let calls = 0
  const send = () => { calls++; if (calls === 1) throw new Error('socket closed') }
  const out = await streamAndPersist({ assistantId: id, stream: gen(['a', 'b', 'c']), send })
  assert.equal(out, 'abc')
  const row = getMessages('u1')[0]
  assert.equal(row.content, 'abc')
  assert.equal(row.status, 'done')
  db.close()
})

test('流抛错时落库 status=error 并向上抛', async () => {
  const db = setup()
  const { id } = appendMessage('u1', { role: 'assistant', content: '', status: 'generating' })
  async function* boom() { yield 'a'; throw new Error('llm boom') }
  await assert.rejects(streamAndPersist({ assistantId: id, stream: boom(), send: () => {} }))
  assert.equal(getMessages('u1')[0].status, 'error')
  db.close()
})
